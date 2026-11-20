import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { NonRetryableTargetError } from "../../common/target-call.js";
import { parseUsage } from "../../contracts.js";

export const MAX_FRAMEWORK_LINE_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;

export interface PythonFrameworkTargetOptions {
  factory: string;
  pythonExecutable?: string;
  cwd?: string;
  timeoutMs?: number;
}

export class PythonFrameworkError extends NonRetryableTargetError {
  override name = "PythonFrameworkError";
}

export class PythonFrameworkTimeoutError extends PythonFrameworkError {
  override name = "PythonFrameworkTimeoutError";
}

interface Pending {
  id: number;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

interface WireResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: {
    type: string;
    message: string;
    status_code?: number;
    usage?: unknown;
  };
}

const aborted = (signal: AbortSignal) =>
  Object.assign(new Error("Python framework call aborted"), {
    name: "AbortError",
    cause: signal.reason,
  });

export class PythonFrameworkBridge {
  readonly timeoutMs: number;
  private child?: ChildProcessWithoutNullStreams;
  private exited: Promise<void> = Promise.resolve();
  private pending?: Pending;
  private nextId = 0;
  private queue: Promise<void> = Promise.resolve();
  private buffer = Buffer.alloc(0);
  private stderr = Buffer.alloc(0);
  private initialized = false;
  private closed = false;
  private fatal?: Error;
  private terminating = false;
  private termination: Promise<void> = Promise.resolve();

  constructor(
    readonly framework: "crewai" | "pydantic_ai",
    readonly options: PythonFrameworkTargetOptions,
    private readonly targetOptions: Record<string, unknown>,
    private readonly memoryEntityId: string,
    private readonly historyMode: "caller" | "target",
  ) {
    if (!options.factory.trim() || !options.factory.includes(":"))
      throw new TypeError(
        "factory must name a Python module or file and callable, such as module:make_agent",
      );
    this.timeoutMs = options.timeoutMs ?? 120_000;
    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs <= 0 ||
      this.timeoutMs > 2147483647
    )
      throw new RangeError(
        "timeoutMs must be an integer between 1 and 2147483647",
      );
    if (
      options.pythonExecutable !== undefined &&
      !options.pythonExecutable.trim()
    )
      throw new TypeError("pythonExecutable must not be blank");
  }

  request(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let active = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error: unknown, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (error !== undefined) reject(error);
        else resolve(value);
      };
      const stop = (error: Error) => {
        if (active) this.fail(error);
        finish(error);
      };
      const onAbort = () => stop(aborted(signal as AbortSignal));
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(
        () =>
          stop(
            new PythonFrameworkTimeoutError(
              `${this.framework} worker timed out after ${this.timeoutMs} ms`,
            ),
          ),
        this.timeoutMs,
      );
      const run = async () => {
        if (settled) return;
        active = true;
        try {
          if (this.closed)
            throw new PythonFrameworkError("Python framework target is closed");
          if (this.fatal) throw this.fatal;
          if (!this.initialized) {
            this.start();
            const initialized = (await this.send("init", {
              framework: this.framework,
              factory: this.options.factory,
              target_options: this.targetOptions,
              memory_entity_id: this.memoryEntityId,
            })) as Record<string, unknown>;
            if (
              initialized?.history_mode !== this.historyMode ||
              initialized.memory_entity_id !== this.memoryEntityId
            )
              throw new PythonFrameworkError(
                "Python worker returned an incompatible target contract",
              );
            this.initialized = true;
          }
          finish(undefined, await this.send(method, params));
        } catch (error) {
          const failure =
            !this.initialized && !(error instanceof PythonFrameworkError)
              ? new PythonFrameworkError(
                  `Python framework initialization failed: ${String(error)}`,
                  { cause: error },
                )
              : error;
          if (!this.initialized || failure instanceof PythonFrameworkError)
            this.fail(
              failure instanceof Error
                ? failure
                : new PythonFrameworkError(String(failure)),
            );
          finish(failure);
        } finally {
          active = false;
        }
      };
      const queued = this.queue.then(run, run);
      this.queue = queued.then(
        () => undefined,
        () => undefined,
      );
    });
  }

  private start(): void {
    if (this.child) return;
    const worker = fileURLToPath(
      new URL(
        "../../../../static/python-frameworks/worker.py",
        import.meta.url,
      ),
    );
    if (!existsSync(worker))
      throw new PythonFrameworkError(
        `Python framework worker is missing: ${worker}`,
      );
    const executable = this.options.pythonExecutable ?? "python3";
    const child = spawn(executable, ["-u", worker], {
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    this.child = child;
    this.exited = new Promise((resolve) =>
      child.once("close", () => resolve()),
    );
    child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = Buffer.concat([this.stderr, chunk]);
      if (this.stderr.length > MAX_STDERR_BYTES)
        this.stderr = this.stderr.subarray(
          this.stderr.length - MAX_STDERR_BYTES,
        );
    });
    child.stdin.on("error", (error) =>
      this.fail(
        new PythonFrameworkError(
          `Python worker input failed: ${error.message}`,
        ),
      ),
    );
    child.on("error", (error) =>
      this.fail(
        new PythonFrameworkError(
          `Could not start Python framework worker with ${JSON.stringify(executable)}: ${error.message}. Select a Python environment containing evaluatorq and ${this.framework}.`,
        ),
      ),
    );
    child.on("close", (code, signal) => {
      if (this.closed || this.fatal) return;
      const tail = this.stderr.toString("utf8").trim();
      this.fail(
        new PythonFrameworkError(
          `Python framework worker exited (${signal ?? code ?? "unknown"})${tail ? `; stderr tail: ${tail}` : ""}`,
        ),
      );
    });
  }

  private send(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (this.fatal) return Promise.reject(this.fatal);
    if (!this.child)
      return Promise.reject(
        new PythonFrameworkError("Python worker has not started"),
      );
    const id = ++this.nextId;
    let line: string;
    try {
      line = `${JSON.stringify({ id, method, params }, (_key, value) => {
        if (
          ["function", "symbol", "bigint", "undefined"].includes(
            typeof value,
          ) ||
          (typeof value === "number" && !Number.isFinite(value))
        )
          throw new TypeError(
            "Python framework messages and options must be JSON-serializable",
          );
        return value;
      })}\n`;
    } catch (error) {
      return Promise.reject(new PythonFrameworkError(String(error)));
    }
    if (Buffer.byteLength(line) > MAX_FRAMEWORK_LINE_BYTES)
      return Promise.reject(
        new PythonFrameworkError(
          `Python framework request exceeds ${MAX_FRAMEWORK_LINE_BYTES} bytes`,
        ),
      );
    return new Promise((resolve, reject) => {
      this.pending = { id, resolve, reject };
      this.child?.stdin.write(line, (error) => {
        if (error)
          this.fail(
            new PythonFrameworkError(
              `Python worker input failed: ${error.message}`,
            ),
          );
      });
    });
  }

  private receive(chunk: Buffer): void {
    if (this.fatal || this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const end = this.buffer.indexOf(10);
      if (end < 0) {
        if (this.buffer.length > MAX_FRAMEWORK_LINE_BYTES)
          this.fail(
            new PythonFrameworkError(
              "Python worker response exceeds the JSONL line limit",
            ),
          );
        return;
      }
      if (end + 1 > MAX_FRAMEWORK_LINE_BYTES) {
        this.fail(
          new PythonFrameworkError(
            "Python worker response exceeds the JSONL line limit",
          ),
        );
        return;
      }
      const bytes = this.buffer.subarray(0, end);
      this.buffer = this.buffer.subarray(end + 1);
      let response: WireResponse;
      try {
        const line = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        response = JSON.parse(line) as WireResponse;
        if (
          !response ||
          !Number.isSafeInteger(response.id) ||
          typeof response.ok !== "boolean" ||
          response.id !== this.pending?.id ||
          (response.ok
            ? !Object.hasOwn(response, "result")
            : typeof response.error?.message !== "string" ||
              typeof response.error?.type !== "string")
        )
          throw new Error("unexpected response shape or request id");
      } catch (error) {
        this.fail(
          new PythonFrameworkError(
            `Invalid Python worker JSONL response: ${String(error)}`,
          ),
        );
        return;
      }
      const pending = this.pending as Pending;
      this.pending = undefined;
      if (response.ok) pending.resolve(response.result);
      else {
        const remote = response.error as NonNullable<WireResponse["error"]>;
        const error =
          remote.type === "ProtocolError"
            ? new PythonFrameworkError(remote.message)
            : new Error(`${this.framework}: ${remote.type}: ${remote.message}`);
        if (remote.status_code !== undefined)
          Object.assign(error, { status: remote.status_code });
        if (remote.usage !== undefined && remote.usage !== null) {
          try {
            Object.assign(error, { usage: parseUsage(remote.usage) });
          } catch (cause) {
            this.fail(
              new PythonFrameworkError(
                `Invalid usage on Python worker error: ${String(cause)}`,
              ),
            );
            pending.reject(this.fatal);
            return;
          }
        }
        pending.reject(error);
      }
    }
  }

  private fail(error: Error): void {
    this.fatal ??= error;
    this.pending?.reject(this.fatal);
    this.pending = undefined;
    this.buffer = Buffer.alloc(0);
    const child = this.child;
    if (!child || this.terminating) return;
    this.terminating = true;
    if (process.platform === "win32" && child.pid) {
      const killer = spawn(
        "taskkill",
        ["/pid", String(child.pid), "/t", "/f"],
        {
          stdio: "ignore",
          windowsHide: true,
        },
      );
      this.termination = new Promise((resolve) => {
        const timer = setTimeout(() => {
          killer.kill("SIGKILL");
          child.kill("SIGKILL");
        }, 2000);
        const finish = (failed: boolean) => {
          clearTimeout(timer);
          if (failed) child.kill("SIGKILL");
          resolve();
        };
        killer.once("error", () => finish(true));
        killer.once("close", (code) => finish(code !== 0));
      });
      return;
    }
    if (process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
        return;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ESRCH") return;
      }
    }
    child.kill("SIGKILL");
  }

  async close(): Promise<void> {
    this.closed = true;
    this.fail(new PythonFrameworkError("Python framework target is closed"));
    await Promise.all([this.exited, this.termination]);
  }
}
