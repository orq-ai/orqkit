import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

/**
 * Replaces a file atomically with mode 0o600, in an owned, non-symlink directory.
 * Explicit user exports may set `privateDirectory: false` to keep an existing
 * destination directory's permissions.
 */
export async function writePrivateAtomic(
  path: string,
  contents: string | Uint8Array,
  options: { privateDirectory?: boolean; mode?: number } = {},
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { mode: 0o700, recursive: true });
  const info = await lstat(directory);
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    (process.getuid !== undefined && info.uid !== process.getuid())
  ) {
    throw new Error(
      `Private file storage is not an owned directory: ${directory}`,
    );
  }
  if (options.privateDirectory ?? true) {
    await chmod(directory, 0o700);
  }
  const stem = basename(path, extname(path));
  const temporary = join(
    directory,
    `.${stem}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    const handle = await open(temporary, "wx", options.mode ?? 0o600);
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
