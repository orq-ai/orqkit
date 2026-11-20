import { randomBytes } from "node:crypto";
import { link, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const POLL_MS = 25;
const STALE_GUARD_MS = 10_000;

const queues = new Map<string, Promise<unknown>>();

const hasCode = (error: unknown, code: string): boolean =>
  (error as { code?: unknown } | null)?.code === code;

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

// A guard stops two waiters that both saw the dead holder: without it the
// slower one would delete the lock the faster one has just taken.
async function removeStaleLock(path: string): Promise<void> {
  const guard = `${path}.takeover`;
  const taken = await open(guard, "wx", 0o600).catch(async (error: unknown) => {
    if (!hasCode(error, "EEXIST")) {
      throw error;
    }
    const age = await stat(guard).then(
      (info) => Date.now() - info.mtimeMs,
      () => 0,
    );
    if (age > STALE_GUARD_MS) {
      await rm(guard, { force: true });
    }
    return null;
  });
  if (taken === null) {
    return;
  }
  try {
    if (await holderIsGone(path)) {
      await rm(path, { force: true });
    }
  } finally {
    await taken.close();
    await rm(guard, { force: true });
  }
}

async function acquire(path: string): Promise<void> {
  for (;;) {
    try {
      const temporary = `${path}.${process.pid}.${randomBytes(12).toString("hex")}`;
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(String(process.pid));
        await handle.close();
        // Publish the complete owner atomically so a crash cannot leave an empty lock.
        await link(temporary, path);
      } finally {
        await handle.close();
        await rm(temporary, { force: true });
      }
      return;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) {
        throw error;
      }
    }
    if (await holderIsGone(path)) {
      await removeStaleLock(path);
    }
    await new Promise((done) =>
      setTimeout(done, POLL_MS + (randomBytes(1)[0] as number) / 16),
    );
  }
}

/**
 * Holds a lock across async callers and processes while `fn` runs. Node has no
 * flock, so a `<path>.held` file names the holder's pid and goes away on release;
 * a holder that died is detected and replaced.
 */
export async function withFileLock<T>(
  path: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = resolve(path);
  const previous = queues.get(key) ?? Promise.resolve();
  const run = async (): Promise<T> => {
    await mkdir(dirname(key), { recursive: true });
    const held = `${key}.held`;
    await acquire(held);
    try {
      return await fn();
    } finally {
      await rm(held, { force: true });
    }
  };
  const current = previous.then(run, run);
  const settled = current.catch(() => undefined);
  queues.set(key, settled);
  try {
    return await current;
  } finally {
    if (queues.get(key) === settled) {
      queues.delete(key);
    }
  }
}
