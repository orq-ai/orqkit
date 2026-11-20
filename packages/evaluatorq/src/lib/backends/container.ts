import { spawn, spawnSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, posix, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod/v4";

// src/lib/backends and dist/lib/backends both sit three levels below the package root.
const PACKAGE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

export const CODING_AGENT_BUILD_DIR = join(
  PACKAGE_ROOT,
  "static",
  "coding-agent-docker",
);

export function imageTagVersion(): string {
  let version = "0.0.0.dev0";
  try {
    const parsed = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"),
    ) as {
      version?: unknown;
    };
    if (typeof parsed.version === "string") version = parsed.version;
  } catch {}
  return version.replace(/[^A-Za-z0-9_.-]/g, "-");
}

export const DEFAULT_CODING_AGENT_IMAGE = `evaluatorq-coding-agent:${imageTagVersion()}`;
export const CONTAINER_LABEL = "evaluatorq.coding-agent";
export const HOST_PID_LABEL = "evaluatorq.host-pid";
export const HOST_LABEL = "evaluatorq.host";
export const RESERVED_ENV = ["HOME", "PATH"] as const;
export const HEARTBEAT_S = 30;
export const LEASE_CHECK_S = 150;
export const ORQ_ENV = ["ORQ_API_KEY", "ORQ_BASE_URL"] as const;
const ISOLATION_FLAGS = new Set([
  "--privileged",
  "--pid=host",
  "--network=host",
  "--net=host",
  "--ipc=host",
  "--userns=host",
  "--uts=host",
]);
const ISOLATION_PAIRS = new Set([
  "--pid",
  "--network",
  "--net",
  "--ipc",
  "--userns",
  "--uts",
]);
const RESERVED_LABELS = new Set([CONTAINER_LABEL, HOST_PID_LABEL, HOST_LABEL]);
const MANAGED_VALUE_FLAGS = new Set(["--entrypoint", "--user", "-u"]);
// The packaged image's `agent` user. A Windows host has no uid to map, so the container runs as this one.
export const IMAGE_AGENT_ID = 1001;

/** Python `repr()` of a string, which the error and warning texts quote values with. */
export function pyRepr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let body = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\\") body += "\\\\";
    else if (char === quote) body += `\\${quote}`;
    else if (char === "\n") body += "\\n";
    else if (char === "\r") body += "\\r";
    else if (char === "\t") body += "\\t";
    else if (code < 0x20 || code === 0x7f)
      body += `\\x${code.toString(16).padStart(2, "0")}`;
    else body += char;
  }
  return `${quote}${body}${quote}`;
}

/** A command the user can paste into a terminal: `shlex.join` on POSIX, `list2cmdline` on Windows. */
export function shellJoin(args: readonly string[]): string {
  if (process.platform === "win32") return args.map(cmdlineArg).join(" ");
  return args
    .map((arg) => {
      if (arg === "") return "''";
      if (!/[^\w@%+=:,./-]/.test(arg)) return arg;
      return `'${arg.replaceAll("'", `'"'"'`)}'`;
    })
    .join(" ");
}

function cmdlineArg(arg: string): string {
  if (arg !== "" && !/[ \t]/.test(arg))
    return arg.replace(/(\\*)"/g, '$1$1\\"');
  let out = "",
    slashes = 0;
  for (const char of arg) {
    if (char === "\\") {
      slashes++;
      continue;
    }
    out +=
      char === '"'
        ? `${"\\".repeat(slashes * 2)}\\"`
        : "\\".repeat(slashes) + char;
    slashes = 0;
  }
  return `"${out}${"\\".repeat(slashes * 2)}"`;
}

export function hostIds(): [number, number] {
  if (
    typeof process.getuid === "function" &&
    typeof process.getgid === "function"
  )
    return [process.getuid(), process.getgid()];
  return [IMAGE_AGENT_ID, IMAGE_AGENT_ID];
}

const MANAGED_MOUNTS = ["/evq-lease", "/evq-home"];

function pick(
  raw: Record<string, unknown>,
  camel: string,
  snake: string,
): unknown {
  return camel in raw ? raw[camel] : raw[snake];
}

export const DockerOptionsSchema = z
  .preprocess(
    (raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
      const value = raw as Record<string, unknown>;
      return {
        ...value,
        runArgs: pick(value, "runArgs", "run_args"),
        passEnv: pick(value, "passEnv", "pass_env"),
        namePrefix: pick(value, "namePrefix", "name_prefix"),
        allowPrivilegeEscalation: pick(
          value,
          "allowPrivilegeEscalation",
          "allow_privilege_escalation",
        ),
      };
    },
    z.object({
      image: z.string().default(DEFAULT_CODING_AGENT_IMAGE),
      binary: z.string().default("docker"),
      context: z.string().nullable().default(null),
      workdir: z.string().default("/work"),
      namePrefix: z.string().default("evq"),
      runArgs: z.array(z.string()).default(() => []),
      passEnv: z.array(z.string()).nullable().default(null),
      allowPrivilegeEscalation: z.boolean().default(false),
    }),
  )
  .superRefine((opts, ctx) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(opts.namePrefix))
      ctx.addIssue({
        code: "custom",
        path: ["namePrefix"],
        message: "name_prefix must be a Docker-safe single path component",
      });
    const workdirError = workdirProblem(opts.workdir);
    if (workdirError)
      ctx.addIssue({
        code: "custom",
        path: ["workdir"],
        message: workdirError,
      });
    if (opts.binary === "podman" && opts.context !== null)
      ctx.addIssue({
        code: "custom",
        message:
          "Podman does not use Docker's --context; select a connection with CONTAINER_CONNECTION",
      });
    const runArgsError = managedRunArgsProblem(
      opts.runArgs,
      opts.allowPrivilegeEscalation,
    );
    if (runArgsError)
      ctx.addIssue({
        code: "custom",
        path: ["runArgs"],
        message: runArgsError,
      });
  });

export type DockerOptions = Readonly<z.infer<typeof DockerOptionsSchema>>;
export type DockerOptionsInput = z.input<typeof DockerOptionsSchema>;

/** Validated, frozen container options; warns when `runArgs` carries raw environment flags. */
export function dockerOptions(input: DockerOptionsInput = {}): DockerOptions {
  const parsed = DockerOptionsSchema.parse(input);
  if (rawEnvironmentFlags(parsed.runArgs).length)
    console.warn(
      "DockerOptions.run_args contains raw environment flags; these bypass pass_env filtering",
    );
  Object.freeze(parsed.runArgs);
  if (parsed.passEnv) Object.freeze(parsed.passEnv);
  return Object.freeze(parsed);
}

function workdirProblem(value: string): string | null {
  if (!value.startsWith("/"))
    return `workdir must be an absolute container path, got ${pyRepr(value)}`;
  const normalized = pyNormpath(`/${value.replace(/^\/+/, "")}`);
  const trimmed = normalized.replace(/\/+$/, "");
  if (
    MANAGED_MOUNTS.some(
      (mount) =>
        normalized === mount ||
        normalized.startsWith(`${mount}/`) ||
        mount.startsWith(`${trimmed}/`),
    )
  )
    return `workdir ${pyRepr(value)} overlaps evaluatorq-managed container mounts /evq-lease and /evq-home`;
  return null;
}

/** `posixpath.normpath`, which keeps a leading `//` that `path.posix.normalize` also keeps. */
function pyNormpath(value: string): string {
  if (value === "") return ".";
  const normalized = posix.normalize(value);
  const keepDouble = value.startsWith("//") && !value.startsWith("///");
  const trimmed =
    normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
  return keepDouble
    ? `/${trimmed.replace(/^\/+/, "/")}`
    : trimmed.replace(/^\/+/, "/");
}

export function dockerCli(opts: DockerOptions): string[] {
  return cliPrefix(opts.binary, opts.context);
}

export function cliPrefix(
  binary: string,
  context: string | null | undefined,
): string[] {
  return context ? [binary, "--context", context] : [binary];
}

/** A BusyBox-compatible process that exits after the host lease stops changing. */
export function watchdogScript(checkS: number = LEASE_CHECK_S): string {
  return (
    `p=; while sleep ${checkS}; do c=$(cat /evq-lease/beat) || break; ` +
    '[ "$c" != "$p" ] || break; p=$c; done; ' +
    'echo "lease_expired $(date)" > /evq-home/.evq-exit'
  );
}

export function buildRunArgv(
  opts: DockerOptions,
  args: {
    name: string;
    root: string;
    leaseDir: string;
    uid: number;
    gid: number;
  },
): string[] {
  const argv = [
    ...dockerCli(opts),
    "run",
    "-d",
    "--rm",
    "--init",
    "--entrypoint",
    "sh",
    "--name",
    args.name,
    "--label",
    `${CONTAINER_LABEL}=1`,
    "--label",
    `${HOST_PID_LABEL}=${process.pid}`,
    "--label",
    `${HOST_LABEL}=${hostname()}`,
    "--user",
    `${args.uid}:${args.gid}`,
    "-e",
    "HOME=/evq-home",
    "-v",
    `${join(args.root, "home")}:/evq-home`,
    "-v",
    `${args.leaseDir}:/evq-lease:ro`,
    "-v",
    `${join(args.root, "work")}:${opts.workdir}`,
    "-w",
    opts.workdir,
  ];
  if (!opts.allowPrivilegeEscalation)
    argv.push("--security-opt", "no-new-privileges");
  return [...argv, ...opts.runArgs, opts.image, "-c", watchdogScript()];
}

export function buildExecArgv(
  opts: DockerOptions,
  args: {
    name: string;
    envNames: readonly string[];
    agentArgv: readonly string[];
  },
): string[] {
  const envFlags = args.envNames.flatMap((key) => ["-e", key]);
  return [
    ...dockerCli(opts),
    "exec",
    "-i",
    "-w",
    opts.workdir,
    ...envFlags,
    args.name,
    "evq-entrypoint",
    ...args.agentArgv,
  ];
}

/** Set environment names, with caller env keys taking precedence in order. */
export function forwardedEnvNames(
  opts: DockerOptions,
  args: {
    launcher: string;
    providerEnv: readonly string[];
    callerEnv: Record<string, string>;
    hostEnv?: NodeJS.ProcessEnv;
  },
): string[] {
  const hostEnv = args.hostEnv ?? process.env;
  const selected =
    opts.passEnv ?? (args.launcher === "orq" ? ORQ_ENV : args.providerEnv);
  const names = new Set([
    ...Object.keys(args.callerEnv),
    ...selected.filter((key) => key in hostEnv),
  ]);
  return [...names].filter(
    (key) => !(RESERVED_ENV as readonly string[]).includes(key),
  );
}

function partition(arg: string): [string, boolean, string] {
  const index = arg.indexOf("=");
  return index < 0
    ? [arg, false, ""]
    : [arg.slice(0, index), true, arg.slice(index + 1)];
}

export function isolationBreakingFlags(runArgs: readonly string[]): string[] {
  const found: string[] = [];
  runArgs.forEach((arg, i) => {
    const [flag, eq, value] = partition(arg);
    const privilegedEnabled =
      flag === "--privileged" &&
      eq &&
      ["1", "t", "true"].includes(value.toLowerCase());
    const next = runArgs[i + 1];
    if (
      ISOLATION_FLAGS.has(arg) ||
      privilegedEnabled ||
      arg.startsWith("--cap-add")
    )
      found.push(arg);
    else if (flag === "--volumes-from")
      found.push(eq ? arg : next !== undefined ? `${arg} ${next}` : arg);
    else if (ISOLATION_PAIRS.has(arg) && next === "host")
      found.push(`${arg} host`);
  });
  return found;
}

function mountFields(value: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const part of value.split(",")) {
    const [key, , fieldValue] = partition(part);
    fields[key] = fieldValue;
  }
  return fields;
}

function isRelativeTo(path: string, root: string): boolean {
  return (
    path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
  );
}

/** Bind-mount host sources outside `root`, and relative host sources. */
export function unsafeMounts(
  runArgs: readonly string[],
  root: string,
): string[] {
  const sources: [string, boolean][] = [];
  runArgs.forEach((arg, i) => {
    let [flag, eq, value] = partition(arg);
    if (arg === "-v" || arg === "--volume" || arg === "--mount") {
      const next = runArgs[i + 1];
      if (next === undefined) return;
      flag = arg;
      value = next;
    } else if ((flag === "--volume" || flag === "--mount") && eq) {
    } else if (arg.startsWith("-v") && arg.length > 2) {
      flag = "-v";
      value = arg.slice(2);
    } else return;
    let src: string | undefined;
    if (flag === "--mount") {
      const fields = mountFields(value);
      src = fields.source || fields.src;
      if (fields.type === "volume") src = undefined;
    } else
      src = value.includes(":")
        ? value.slice(0, value.indexOf(":"))
        : undefined;
    if (src) sources.push([src, flag === "--mount"]);
  });
  const resolvedRoot = resolve(root);
  const unsafe: string[] = [];
  for (const [src, mountSource] of sources) {
    if (src.startsWith("/")) {
      if (!isRelativeTo(resolve(src), resolvedRoot)) unsafe.push(src);
    } else if (
      mountSource ||
      src.startsWith(".") ||
      src.startsWith("~") ||
      src.includes("/")
    )
      unsafe.push(src);
  }
  return unsafe;
}

/** Raw Docker environment flags that bypass `passEnv` selection. */
export function rawEnvironmentFlags(runArgs: readonly string[]): string[] {
  return runArgs.filter(
    (arg) =>
      arg === "-e" ||
      arg === "--env" ||
      arg === "--env-file" ||
      ((arg.startsWith("--env=") ||
        arg.startsWith("--env-file=") ||
        arg.startsWith("-e")) &&
        arg !== "-e"),
  );
}

function managedRunArgsProblem(
  args: readonly string[],
  allowPrivilegeEscalation: boolean,
): string | null {
  const violations: string[] = [];
  args.forEach((arg, i) => {
    const [flag, eq, value] = partition(arg);
    const next = args[i + 1];
    const mountFlag = ["--volume", "-v", "--mount"].includes(flag)
      ? flag
      : arg.startsWith("-v")
        ? "-v"
        : null;
    let mountValue = "";
    if (mountFlag) {
      if (eq) mountValue = value;
      else if (mountFlag === "-v" && arg !== "-v") mountValue = arg.slice(2);
      else mountValue = next ?? "";
    }
    if (
      MANAGED_VALUE_FLAGS.has(flag) ||
      (arg.startsWith("-u") && arg !== "-u")
    ) {
      violations.push(arg);
      return;
    }
    if (
      flag === "--name" ||
      (flag === "--label" &&
        RESERVED_LABELS.has(partition(eq ? value : (next ?? ""))[0]))
    ) {
      violations.push(eq ? arg : `${arg} ${next ?? ""}`.trimEnd());
      return;
    }
    if (mountFlag && isReservedMountTarget(mountTarget(mountFlag, mountValue)))
      violations.push(
        eq || (arg.startsWith("-v") && arg !== "-v")
          ? arg
          : `${arg} ${mountValue}`,
      );
    if (
      flag === "--rm" &&
      eq &&
      ["f", "false", "0"].includes(value.toLowerCase())
    )
      violations.push(arg);
    if (!allowPrivilegeEscalation && flag === "--security-opt") {
      const securityOpt = eq ? value : (next ?? "");
      if (securityOpt.toLowerCase() === "no-new-privileges=false")
        violations.push(eq ? arg : `${arg} ${securityOpt}`);
    }
  });
  if (!violations.length) return null;
  return (
    "run_args cannot override evaluatorq-managed entrypoint, user, auto-remove, lease/home mounts, " +
    "or no-new-privileges unless privilege escalation is enabled: " +
    violations.map(pyRepr).join(", ")
  );
}

/** Reject run flags that replace lifecycle controls supplied by evaluatorq. */
export function validateManagedRunArgs(
  runArgs: readonly string[],
  options: { allowPrivilegeEscalation?: boolean } = {},
): void {
  const problem = managedRunArgsProblem(
    runArgs,
    options.allowPrivilegeEscalation ?? false,
  );
  if (problem) throw new Error(problem);
}

function mountTarget(flag: string, value: string): string | null {
  if (flag === "--mount") {
    const fields = mountFields(value);
    return fields.target || fields.dst || fields.destination || null;
  }
  const parts = value.split(":");
  if (parts.length > 1) return parts[1] ?? null;
  return value.startsWith("/") ? value : null;
}

function isReservedMountTarget(target: string | null): boolean {
  if (target === null) return false;
  const normalized = pyNormpath(target);
  return (
    normalized === "/evq-lease" ||
    normalized === "/evq-home" ||
    normalized.startsWith("/evq-lease/") ||
    normalized.startsWith("/evq-home/")
  );
}

/** Identity and lease file for a container owned by this process. */
export interface LiveContainer {
  readonly binary: string;
  readonly context: string | null;
  readonly beat: string;
}

/** Every container this process started and has not removed. */
export const LIVE_CONTAINERS = new Map<string, LiveContainer>();
export const BEAT_WARNED = new Set<string>();

interface HookState {
  exitInstalled: boolean;
  signalsInstalled: boolean;
  heartbeat: ReturnType<typeof setInterval> | null;
  counter: number;
  handlers: [NodeJS.Signals, (signal: NodeJS.Signals) => void][];
}
export const hookState: HookState = {
  exitInstalled: false,
  signalsInstalled: false,
  heartbeat: null,
  counter: 0,
  handlers: [],
};

/** Seams tests replace: process cleanup hooks, the heartbeat, removal and the clock. */
export const containerRuntime = {
  installExitHooks: () => installExitHooks(),
  startHeartbeat: () => startHeartbeat(),
  removeContainers: (
    binary: string,
    context: string | null,
    names: readonly string[],
    options?: { timeoutS?: number },
  ): string[] => removeContainers(binary, context, names, options),
  monotonic: (): number => performance.now() / 1000,
  signals: (): NodeJS.Signals[] =>
    process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"],
};

/** Track a container and ensure process cleanup and heartbeat are active. */
export function register(name: string, live: LiveContainer): void {
  LIVE_CONTAINERS.set(name, live);
  containerRuntime.installExitHooks();
  containerRuntime.startHeartbeat();
}

/** Forget a container, which also stops renewing its lease. */
export function unregister(name: string): LiveContainer | null {
  BEAT_WARNED.delete(name);
  const live = LIVE_CONTAINERS.get(name) ?? null;
  LIVE_CONTAINERS.delete(name);
  return live;
}

interface ControlResult {
  status: number | null;
  stderr: string;
  error?: Error;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nextRemoval(
  pending: string[],
  result: ControlResult,
): { done: true } | { done: false; pending: string[]; reason: string } {
  if (result.error)
    return { done: false, pending, reason: result.error.message };
  if (result.status === 0) return { done: true };
  const lines = result.stderr.split(/\r?\n/).filter((line) => line.trim());
  const mentions = (line: string, name: string) =>
    new RegExp(
      `(?<![A-Za-z0-9_.-])${escapeRegex(name)}(?![A-Za-z0-9_.-])`,
    ).test(line);
  const missing = new Set(
    pending.filter((name) =>
      lines.some(
        (line) => mentions(line, name) && line.includes("No such container"),
      ),
    ),
  );
  const failed = pending.filter(
    (name) => !missing.has(name) && lines.some((line) => mentions(line, name)),
  );
  if (
    !failed.length &&
    lines.length &&
    lines.every((line) => line.includes("No such container"))
  )
    return { done: true };
  const remaining = pending.filter((name) => !missing.has(name));
  return {
    done: false,
    pending: failed.length ? failed : remaining.length ? remaining : pending,
    reason:
      result.stderr.trim() || `command exited with status ${result.status}`,
  };
}

function reportRemovalFailure(
  binary: string,
  context: string | null,
  pending: string[],
  reason: string,
): string[] {
  const command = shellJoin([
    ...cliPrefix(binary, context),
    "rm",
    "-f",
    ...pending,
  ]);
  console.error(
    `could not remove container(s) ${pending.join(", ")}: ${reason}. Their lease ends them within ` +
      `${LEASE_CHECK_S * 2}s; to remove now run: ${command}`,
  );
  return pending;
}

function spawnError(
  error: unknown,
  timedOut: boolean,
  timeoutS: number,
): Error {
  if (timedOut) return new Error(`Command timed out after ${timeoutS} seconds`);
  return error instanceof Error ? error : new Error(String(error));
}

/** Remove containers in one batch, retry once, and return names that still fail. */
export function removeContainers(
  binary: string,
  context: string | null,
  names: readonly string[],
  options: { timeoutS?: number } = {},
): string[] {
  const timeoutS = options.timeoutS ?? 10;
  let pending = [...new Set(names)];
  let reason = "unknown removal error";
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!pending.length) return [];
    const [command, ...rest] = [
      ...cliPrefix(binary, context),
      "rm",
      "-f",
      ...pending,
    ];
    const proc = spawnSync(command as string, rest, {
      encoding: "utf8",
      timeout: Math.max(1, Math.round(timeoutS * 1000)),
      killSignal: "SIGKILL",
    });
    const timedOut =
      (proc.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    const next = nextRemoval(pending, {
      status: proc.status,
      stderr: proc.stderr ?? "",
      error: proc.error
        ? spawnError(proc.error, timedOut, timeoutS)
        : undefined,
    });
    if (next.done) return [];
    pending = next.pending;
    reason = next.reason;
  }
  return reportRemovalFailure(binary, context, pending, reason);
}

/** Run one bounded control command without blocking the event loop. */
export function runControl(
  argv: readonly string[],
  timeoutS: number,
): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
  error?: NodeJS.ErrnoException;
  timedOut: boolean;
}> {
  return new Promise((done) => {
    const [command, ...rest] = argv;
    const child = spawn(command as string, rest, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      timedOut = false,
      error: NodeJS.ErrnoException | undefined;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutS * 1000);
    child.on("error", (err: NodeJS.ErrnoException) => {
      error = err;
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      done({ status, stdout, stderr, error, timedOut });
    });
  });
}

/** The asynchronous removal primitive, with the same retry and report rules. */
export async function removeContainersAsync(
  binary: string,
  context: string | null,
  names: readonly string[],
  options: { timeoutS?: number } = {},
): Promise<string[]> {
  const timeoutS = options.timeoutS ?? 10;
  let pending = [...new Set(names)];
  let reason = "unknown removal error";
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!pending.length) return [];
    const proc = await runControl(
      [...cliPrefix(binary, context), "rm", "-f", ...pending],
      timeoutS,
    );
    const next = nextRemoval(pending, {
      status: proc.status,
      stderr: proc.stderr,
      error:
        proc.error || proc.timedOut
          ? spawnError(proc.error, proc.timedOut, timeoutS)
          : undefined,
    });
    if (next.done) return [];
    pending = next.pending;
    reason = next.reason;
  }
  return reportRemovalFailure(binary, context, pending, reason);
}

/** Remove registered containers; bound signal cleanup so termination can proceed. */
export function removeAll(
  reason: string,
  options: { maxCleanupS?: number } = {},
): void {
  const deadline =
    options.maxCleanupS !== undefined
      ? containerRuntime.monotonic() + options.maxCleanupS
      : null;
  const snapshot = [...LIVE_CONTAINERS.entries()];
  if (!snapshot.length) return;
  const groups = new Map<
    string,
    { binary: string; context: string | null; names: string[] }
  >();
  for (const [name, live] of snapshot) {
    unregister(name);
    const key = JSON.stringify([live.binary, live.context]);
    const group = groups.get(key) ?? {
      binary: live.binary,
      context: live.context,
      names: [],
    };
    group.names.push(name);
    groups.set(key, group);
  }
  for (const { binary, context, names } of groups.values()) {
    const remaining =
      deadline !== null ? deadline - containerRuntime.monotonic() : null;
    if (remaining !== null && remaining <= 0) {
      console.warn(
        "host_exit cleanup deadline reached; remaining containers will expire with their leases",
      );
      break;
    }
    console.warn(
      `host_exit (${reason}): removing container(s) ${names.join(", ")}`,
    );
    if (remaining === null)
      containerRuntime.removeContainers(binary, context, names);
    else
      containerRuntime.removeContainers(binary, context, names, {
        timeoutS: remaining / 2,
      });
  }
}

/** Finalizer target that removes containers owned by an unclosed target. */
export function releaseContainers(owned: readonly string[]): void {
  for (const name of owned) {
    const live = unregister(name);
    if (live !== null) {
      console.warn(
        `CodingAgentTarget was garbage-collected without close(); removing container ${name}`,
      );
      containerRuntime.removeContainers(live.binary, live.context, [name]);
    }
  }
}

/** Atomically replace a lease heartbeat counter. */
export function writeBeat(path: string, value: number): void {
  const temporary = join(dirname(path), `${basename(path)}.tmp`);
  writeFileSync(temporary, String(value));
  renameSync(temporary, path);
}

/** Renew all currently registered leases, warning only once for each failing name. */
export function heartbeatOnce(counter: number): void {
  for (const [name, live] of [...LIVE_CONTAINERS.entries()]) {
    try {
      writeBeat(live.beat, counter);
      BEAT_WARNED.delete(name);
    } catch (error) {
      if (!BEAT_WARNED.has(name)) {
        BEAT_WARNED.add(name);
        console.warn(
          `heartbeat for container ${name} failed (${(error as Error).message}); its lease ends it if this persists`,
        );
      }
    }
  }
}

/** One unref'd interval renews leases without keeping the process alive. */
export function startHeartbeat(): void {
  if (hookState.heartbeat !== null) return;
  hookState.heartbeat = setInterval(() => {
    hookState.counter++;
    heartbeatOnce(hookState.counter);
  }, HEARTBEAT_S * 1000);
  hookState.heartbeat.unref();
}

/**
 * A signal handler that cleans up, then chains to `previous` or, when nothing
 * else listens for the signal, restores the default action and re-raises it.
 */
export function makeSignalHandler(
  previous?: (signal: NodeJS.Signals) => void,
): (signal: NodeJS.Signals) => void {
  const handler = (signal: NodeJS.Signals): void => {
    removeAll(signal, { maxCleanupS: 5 });
    if (previous) {
      previous(signal);
      return;
    }
    if (process.listenerCount(signal) <= 1) {
      process.removeListener(signal, handler);
      process.kill(process.pid, signal);
    }
  };
  return handler;
}

/** Install exit cleanup and termination signal hooks once. */
export function installExitHooks(): void {
  if (!hookState.exitInstalled) {
    hookState.exitInstalled = true;
    process.once("exit", () => removeAll("atexit"));
  }
  if (!hookState.signalsInstalled) {
    hookState.signalsInstalled = true;
    for (const signal of containerRuntime.signals()) {
      const handler = makeSignalHandler();
      hookState.handlers.push([signal, handler]);
      process.on(signal, handler);
    }
  }
}

/** Whether a PID exists or is inaccessible to this process. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Remove labelled containers on this host whose owning process is no longer alive. */
export async function sweepOrphans(
  binary: string,
  context: string | null,
): Promise<void> {
  const fmt = `{{.Names}}\t{{.Label "${HOST_PID_LABEL}"}}\t{{.Label "${HOST_LABEL}"}}`;
  const proc = await runControl(
    [
      ...cliPrefix(binary, context),
      "ps",
      "-a",
      "--filter",
      `label=${CONTAINER_LABEL}=1`,
      "--format",
      fmt,
    ],
    10,
  );
  if (proc.error || proc.timedOut) {
    console.warn(
      `orphan sweep skipped: ${spawnError(proc.error, proc.timedOut, 10).message}`,
    );
    return;
  }
  if (proc.status !== 0) {
    console.warn(`orphan sweep skipped: ${proc.stderr.trim()}`);
    return;
  }
  const host = hostname(),
    dead: string[] = [];
  for (const line of proc.stdout.split(/\r?\n/)) {
    if (!line) continue;
    const [name = "", pid = "", owner = ""] = line.split("\t");
    if (owner !== host) continue;
    if (!/^\d+$/.test(pid)) {
      console.warn(
        `orphan sweep: container ${name} has an unreadable host-pid label ${pyRepr(pid)}; leaving it to its lease`,
      );
      continue;
    }
    if (!pidAlive(Number(pid))) {
      console.warn(
        `orphan_sweep: removing container ${name}, its host process ${pid} is gone`,
      );
      dead.push(name);
    }
  }
  await removeContainersAsync(binary, context, dead);
}
