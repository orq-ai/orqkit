import { randomBytes } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";

const POLL_MS = 25;
const STALE_GUARD_MS = 10_000;
const WAIT_MS = 30_000;
const queues = new Map<string, Promise<unknown>>();
const hasCode = (error: unknown, code: string): boolean =>
  (error as { code?: unknown } | null)?.code === code;

export class FileLockTimeoutError extends Error {
  override readonly name = "FileLockTimeoutError";
}

async function namespace(): Promise<string | null> {
  return process.platform === "linux"
    ? readlink("/proc/self/ns/pid").catch(() => null)
    : null;
}

function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return hasCode(error, "ESRCH");
  }
}

async function holderIsGone(path: string): Promise<boolean> {
  try {
    const [text, info] = await Promise.all([
      readFile(path, "utf8"),
      stat(path),
    ]);
    let record: unknown;
    try {
      record = JSON.parse(text);
    } catch {}
    if (record !== null && typeof record === "object") {
      const owner = record as Record<string, unknown>;
      if (
        typeof owner.pid === "number" &&
        Number.isSafeInteger(owner.pid) &&
        owner.pid > 0 &&
        owner.pid <= 2147483647 &&
        typeof owner.token === "string"
      ) {
        if (owner.host !== hostname()) return false;
        const localNamespace = await namespace();
        if (
          process.platform === "linux" &&
          (!localNamespace || owner.namespace !== localNamespace)
        )
          return false;
        return processIsGone(owner.pid);
      }
    }
    const pid = Number(text);
    if (
      /^[1-9]\d*$/.test(text) &&
      Number.isSafeInteger(pid) &&
      pid <= 2147483647
    )
      return processIsGone(pid);
    return Date.now() - info.mtimeMs > STALE_GUARD_MS;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function pause(path: string, deadline: number): Promise<void> {
  const remaining = deadline - Date.now();
  if (remaining <= 0)
    throw new FileLockTimeoutError(`Timed out waiting for file lock ${path}`);
  await new Promise((done) => setTimeout(done, Math.min(remaining, POLL_MS)));
}

async function publish(path: string, owner: string): Promise<boolean> {
  const temporary = `${path}.${process.pid}.${randomBytes(12).toString("hex")}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(owner);
    await handle.close();
    try {
      await link(temporary, path);
      return true;
    } catch (error) {
      if (hasCode(error, "EEXIST")) return false;
      throw error;
    }
  } finally {
    await handle.close();
    await rm(temporary, { force: true });
  }
}

async function removeGuard(guard: string): Promise<void> {
  try {
    const info = await stat(guard);
    if (info.isFile()) {
      if (await holderIsGone(guard)) await unlink(guard);
      return;
    }
    const entries = await readdir(guard);
    if (
      entries.length === 1 &&
      /^owner-[a-f0-9]{32}\.json$/.test(entries[0] as string)
    ) {
      const ownerPath = `${guard}/${entries[0]}`;
      if (!(await holderIsGone(ownerPath))) return;
      await unlink(ownerPath);
    } else if (entries.length) return;
    await rmdir(guard);
  } catch (error) {
    if (
      !["ENOENT", "ENOTEMPTY", "EEXIST", "EISDIR", "ENOTDIR"].some((code) =>
        hasCode(error, code),
      )
    )
      throw error;
  }
}

async function releaseGuard(guard: string, name: string): Promise<void> {
  try {
    await unlink(`${guard}/${name}`);
    await rmdir(guard);
  } catch (error) {
    if (
      !["ENOENT", "ENOTEMPTY", "EEXIST", "EISDIR", "ENOTDIR"].some((code) =>
        hasCode(error, code),
      )
    )
      throw error;
  }
}

async function guarded<T>(
  path: string,
  owner: string,
  deadline: number,
  fn: () => Promise<T>,
): Promise<T> {
  const guard = `${path}.takeover`;
  const temporary = await mkdtemp(`${guard}.`);
  const name = `owner-${(JSON.parse(owner) as { token: string }).token}.json`;
  try {
    await writeFile(`${temporary}/${name}`, owner, { mode: 0o600, flag: "wx" });
    for (;;) {
      try {
        // Publish a nonempty directory so stale reapers cannot remove a new owner's guard.
        await rename(temporary, guard);
        break;
      } catch (error) {
        if (
          !["EEXIST", "ENOTEMPTY", "ENOTDIR"].some((code) =>
            hasCode(error, code),
          )
        )
          throw error;
      }
      await removeGuard(guard);
      await pause(guard, deadline);
    }
    try {
      return await fn();
    } finally {
      await releaseGuard(guard, name);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Holds a local file lock with a unique owner; dead owners are recovered within the same host and PID namespace. */
export async function withFileLock<T>(
  path: string,
  fn: () => Promise<T>,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const key = resolve(path),
    held = `${key}.held`;
  const timeout = options.timeoutMs ?? WAIT_MS;
  if (!Number.isFinite(timeout) || timeout <= 0)
    throw new RangeError("Lock timeout must be positive and finite");
  const deadline = Date.now() + timeout;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const waitTimeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(
        new FileLockTimeoutError(`Timed out waiting for file lock ${held}`),
      );
    }, timeout);
  });
  const previous = queues.get(key) ?? Promise.resolve();
  const run = async (): Promise<T> => {
    if (expired)
      throw new FileLockTimeoutError(`Timed out waiting for file lock ${held}`);
    const owner = JSON.stringify({
      pid: process.pid,
      host: hostname(),
      namespace: await namespace(),
      token: randomBytes(16).toString("hex"),
    });
    await mkdir(dirname(key), { recursive: true, mode: 0o700 });
    while (!(await publish(held, owner))) {
      if (await holderIsGone(held))
        await guarded(held, owner, deadline, async () => {
          if (await holderIsGone(held)) await rm(held, { force: true });
        });
      await pause(held, deadline);
    }
    try {
      if (expired || Date.now() >= deadline)
        throw new FileLockTimeoutError(
          `Timed out waiting for file lock ${held}`,
        );
      clearTimeout(timer);
      return await fn();
    } finally {
      await guarded(held, owner, Date.now() + timeout, async () => {
        if ((await readFile(held, "utf8").catch(() => null)) === owner)
          await rm(held, { force: true });
      });
    }
  };
  const current = previous.then(run, run);
  const settled = current.catch(() => undefined);
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  try {
    return await Promise.race([current, waitTimeout]);
  } finally {
    clearTimeout(timer);
  }
}
