import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { z } from "zod/v4";

import { writePrivateAtomic } from "../common/private-files.js";
import { RunExport } from "../trace-finder/export.js";
import { Snapshot } from "../trace-finder/models.js";

export const MAX_INSIGHTS_UPLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_FINDER_EXPORT_BYTES = 10 * 1024 * 1024;
export const SNAPSHOT_TOO_LARGE_MESSAGE = `Upload exceeds the ${MAX_INSIGHTS_UPLOAD_BYTES / (1024 * 1024)} MB size limit.`;
export const MAX_MULTIPART_OVERHEAD_BYTES = 1024 * 1024;
export const UPLOAD_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const UPLOAD_DIRECTORY = ".uploads";
const UPLOAD_NAME = /^(finder|snapshot)-[0-9a-f]{32}\.json$/;
const METADATA_SUFFIX = ".meta.json";

export type UploadKind = "finder" | "snapshot";

export const UploadMetadataSchema = z.object({
  display_name: z.string().max(255),
  modified_at: z.iso.datetime({ offset: true }).nullable().default(null),
  trace_count: z.number().int().min(0),
  kind: z.enum(["finder", "snapshot"]).nullable().default(null),
  source: z.enum(["file", "sessions"]).default("file"),
});
export type UploadMetadata = z.infer<typeof UploadMetadataSchema>;

export interface RecentTraceFile {
  path: string;
  displayName: string;
  date: string;
  traceCount: number;
  kind: UploadKind;
}

export class UploadTooLargeError extends Error {
  override name = "UploadTooLargeError";
}

export class UploadRequestTooLargeError extends Error {
  override name = "UploadRequestTooLargeError";
}

const uid = () => process.getuid?.() ?? null;
const windows = process.platform === "win32";
const isMissing = (error: unknown) =>
  (error as NodeJS.ErrnoException)?.code === "ENOENT";

export const uploadsDir = (runsDir: string) => join(runsDir, UPLOAD_DIRECTORY);
const metadataPathFor = (path: string) =>
  join(dirname(path), basename(path) + METADATA_SUFFIX);

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700, recursive: true });
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new Error("Insights upload storage must be a real directory.");
  if (uid() !== null && info.uid !== uid())
    throw new Error("Insights upload storage has unexpected ownership.");
  await chmod(path, 0o700);
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/** Prune route-owned copies seven days after upload or the latest completed run attempt. */
export async function cleanupExpiredUploads(
  runsDir: string,
  options: { now?: number } = {},
): Promise<number> {
  const directory = uploadsDir(runsDir);
  const info = await lstatOrNull(directory);
  if (!info || info.isSymbolicLink()) return 0;
  await ensurePrivateDirectory(directory);
  const cutoff = (options.now ?? Date.now() / 1000) - UPLOAD_RETENTION_SECONDS;
  let removed = 0;
  for (const name of await readdir(directory)) {
    if (!UPLOAD_NAME.test(name)) continue;
    const path = join(directory, name);
    try {
      const entry = await lstat(path);
      if (
        entry.isFile() &&
        (uid() === null || entry.uid === uid()) &&
        entry.mtimeMs / 1000 < cutoff
      ) {
        await unlink(path);
        const metadataPath = metadataPathFor(path);
        const metadata = await lstatOrNull(metadataPath);
        if (metadata?.isFile() && (uid() === null || metadata.uid === uid()))
          await unlink(metadataPath);
        removed += 1;
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return removed;
}

/** The size-limit message for an upload of `kind`, or null when it fits. */
export function uploadSizeError(kind: UploadKind, size: number): string | null {
  if (kind === "finder" && size > MAX_FINDER_EXPORT_BYTES)
    return `Finder export exceeds the ${MAX_FINDER_EXPORT_BYTES / (1024 * 1024)} MiB size limit.`;
  if (size > MAX_INSIGHTS_UPLOAD_BYTES)
    return "Upload exceeds the 100 MB size limit.";
  return null;
}

const decode = (contents: Uint8Array) =>
  new TextDecoder("utf-8", { fatal: true }).decode(contents);

function parseSnapshot(contents: Uint8Array): Snapshot {
  return new Snapshot(JSON.parse(decode(contents)));
}

function parseExport(contents: Uint8Array): RunExport {
  return new RunExport(JSON.parse(decode(contents)));
}

/**
 * Parse an upload once, classify it by its top-level keys unless `kind` is given, and validate it.
 * Throws UploadTooLargeError above the kind's size limit and Error for any other invalid upload.
 */
export function validateUpload(
  contents: Uint8Array,
  kind: UploadKind | null = null,
): UploadKind {
  let document: unknown;
  try {
    document = JSON.parse(decode(contents));
  } catch {
    throw new Error("This file is not valid JSON.");
  }
  let resolved = kind;
  if (resolved === null) {
    const keys =
      document && typeof document === "object" && !Array.isArray(document)
        ? new Set(Object.keys(document))
        : new Set<string>();
    if (keys.has("matched_trace_ids")) resolved = "finder";
    else if (keys.has("traces") || keys.has("documents")) resolved = "snapshot";
    else
      throw new Error(
        "This file is neither a Finder export nor a trace snapshot.",
      );
  }
  const tooLarge = uploadSizeError(resolved, contents.byteLength);
  if (tooLarge) throw new UploadTooLargeError(tooLarge);
  let empty = false;
  try {
    if (resolved === "finder") new RunExport(document);
    else empty = new Snapshot(document).isEmpty;
  } catch {
    throw new Error(`Upload is not a valid ${resolved} JSON file.`);
  }
  if (empty) throw new Error("The trace snapshot contains no traces.");
  return resolved;
}

function displayName(name: string): string {
  const last = name.replaceAll("\\", "/").split("/").pop() ?? "";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips non-printable characters
  return [...last.replace(/[\u0000-\u001f\u007f-\u009f]/g, "")]
    .slice(0, 255)
    .join("");
}

function traceCount(contents: Uint8Array, kind: UploadKind): number {
  if (kind === "finder") return parseExport(contents).matchedTraceIds.length;
  const snapshot = parseSnapshot(contents);
  return snapshot.traces.length + snapshot.documents.length;
}

const utcNow = () => new Date().toISOString().replace("Z", "+00:00");

/** Store a validated copy and its private display metadata under a random name. */
export async function storeUpload(
  runsDir: string,
  contents: Uint8Array,
  kind: UploadKind,
  options: { displayName?: string; source?: "file" | "sessions" } = {},
): Promise<string> {
  const path = join(
    uploadsDir(runsDir),
    `${kind}-${randomUUID().replaceAll("-", "")}.json`,
  );
  const metadata = UploadMetadataSchema.parse({
    display_name: displayName(options.displayName ?? "") || basename(path),
    modified_at: utcNow(),
    trace_count: traceCount(contents, kind),
    kind,
    source: options.source ?? "file",
  });
  let stored = false;
  try {
    await writePrivateAtomic(path, contents);
    stored = true;
    await writePrivateAtomic(metadataPathFor(path), JSON.stringify(metadata));
  } catch (error) {
    if (stored) await unlink(path).catch(() => {});
    throw error;
  }
  return path;
}

const OUTSIDE =
  "Uploaded source must be inside private Insights upload storage.";

/** Open a private regular file without following a symlink, including metadata sidecars. */
async function readPrivateUploadFile(
  runsDir: string,
  path: string,
  options: { limit: number; refreshRetention?: boolean },
): Promise<Buffer> {
  if (windows)
    throw new Error("Safe Insights upload opening is unavailable on Windows.");
  let directory = uploadsDir(runsDir);
  const [pathInfo, directoryLink] = await Promise.all([
    lstatOrNull(path),
    lstatOrNull(directory),
  ]);
  if (pathInfo?.isSymbolicLink() || directoryLink?.isSymbolicLink())
    throw new Error(OUTSIDE);
  let resolvedPath: string;
  try {
    directory = await realpath(directory);
    resolvedPath = join(await realpath(dirname(path)), basename(path));
  } catch {
    throw new Error(OUTSIDE);
  }
  if (dirname(resolvedPath) !== directory) throw new Error(OUTSIDE);
  const directoryInfo = await lstat(directory);
  if (
    !directoryInfo.isDirectory() ||
    (directoryInfo.mode & 0o777) !== 0o700 ||
    (uid() !== null && directoryInfo.uid !== uid())
  )
    throw new Error("Insights upload storage has unsafe permissions.");
  const handle = await open(
    resolvedPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      (uid() !== null && info.uid !== uid()) ||
      (info.mode & 0o777) !== 0o600
    )
      throw new Error("Uploaded source must be a private regular file.");
    const reopened = await lstat(directory);
    if (
      reopened.ino !== directoryInfo.ino ||
      reopened.dev !== directoryInfo.dev
    )
      throw new Error(
        "Insights upload storage changed while opening the file.",
      );
    if (options.refreshRetention) {
      const now = new Date();
      await handle.utimes(now, now);
    }
    const buffer = Buffer.alloc(options.limit + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        total,
        buffer.length - total,
        null,
      );
      if (!bytesRead) break;
      total += bytesRead;
    }
    return buffer.subarray(0, total);
  } finally {
    await handle.close();
  }
}

/** The kind a stored upload's name records, or null for a file this module did not name. */
export function uploadKind(path: string): UploadKind | null {
  const match = UPLOAD_NAME.exec(basename(path));
  return match ? (match[1] as UploadKind) : null;
}

/** Read and validate only a route-named private upload of the requested kind. */
export async function readUploadedSource(
  runsDir: string,
  path: string,
  kind: UploadKind,
): Promise<Buffer> {
  if (uploadKind(path) !== kind)
    throw new Error("Uploaded source has the wrong file type.");
  const contents = await readPrivateUploadFile(runsDir, path, {
    limit: MAX_INSIGHTS_UPLOAD_BYTES,
  });
  validateUpload(contents, kind);
  return contents;
}

/** Whether a path has the unambiguous route-owned upload shape. */
export async function isUploadedSource(
  runsDir: string,
  path: string,
): Promise<boolean> {
  if (!UPLOAD_NAME.test(basename(path))) return false;
  const directory = uploadsDir(runsDir);
  if (resolve(dirname(path)) === resolve(directory)) return true;
  try {
    return (await realpath(dirname(path))) === (await realpath(directory));
  } catch {
    return false;
  }
}

async function readMetadata(
  runsDir: string,
  metadataPath: string,
): Promise<UploadMetadata> {
  const raw = await readPrivateUploadFile(runsDir, metadataPath, {
    limit: 4096,
  });
  return UploadMetadataSchema.parse(JSON.parse(decode(raw)));
}

/** Keep a valid route-owned copy for seven days after a worker attempt finishes. */
export async function retainUploadedSource(
  runsDir: string,
  path: string,
): Promise<void> {
  const kind = uploadKind(path);
  if (kind === null || !(await isUploadedSource(runsDir, path))) return;
  await readPrivateUploadFile(runsDir, path, {
    limit: 0,
    refreshRetention: true,
  });
  const metadataPath = metadataPathFor(path);
  try {
    const metadata = await readMetadata(runsDir, metadataPath);
    if (metadata.kind === kind)
      await writePrivateAtomic(
        metadataPath,
        JSON.stringify({ ...metadata, modified_at: utcNow() }),
      );
  } catch {
    return;
  }
}

/** Delete a frozen session copy only when its private metadata records that source. */
export async function cleanupSessionUpload(
  runsDir: string,
  path: string,
): Promise<boolean> {
  if (
    uploadKind(path) !== "snapshot" ||
    !(await isUploadedSource(runsDir, path))
  )
    return false;
  const metadataPath = metadataPathFor(path);
  let metadata: UploadMetadata;
  try {
    metadata = await readMetadata(runsDir, metadataPath);
  } catch {
    return false;
  }
  if (metadata.kind !== "snapshot" || metadata.source !== "sessions")
    return false;
  await readPrivateUploadFile(runsDir, path, { limit: 0 });
  await unlink(path).catch((error) => {
    if (!isMissing(error)) throw error;
  });
  await unlink(metadataPath).catch((error) => {
    if (!isMissing(error)) throw error;
  });
  return true;
}

export function fileDate(modifiedSeconds: number): string {
  const iso = new Date(modifiedSeconds * 1000).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

type Entry = [number, RecentTraceFile];

async function recentUploadEntry(
  runsDir: string,
  path: string,
  kind: UploadKind,
): Promise<Entry | null> {
  try {
    await readPrivateUploadFile(runsDir, path, { limit: 0 });
    const metadataPath = metadataPathFor(path);
    let metadata: UploadMetadata;
    if (await lstatOrNull(metadataPath))
      metadata = await readMetadata(runsDir, metadataPath);
    else {
      const contents = await readUploadedSource(runsDir, path, kind);
      metadata = UploadMetadataSchema.parse({
        display_name: basename(path),
        trace_count: traceCount(contents, kind),
        kind,
      });
    }
    if (metadata.kind !== null && metadata.kind !== kind) return null;
    if (metadata.source === "sessions") return null;
    const modified =
      metadata.modified_at !== null
        ? Date.parse(metadata.modified_at) / 1000
        : (await stat(path)).mtimeMs / 1000;
    return [
      modified,
      {
        path,
        displayName: metadata.display_name,
        date: fileDate(modified),
        traceCount: metadata.trace_count,
        kind,
      },
    ];
  } catch {
    return null;
  }
}

async function recentFinderEntry(
  finderDir: string,
  path: string,
): Promise<Entry | null> {
  const { readApprovedFinderExport } = await import("./insights-launch.js");
  try {
    const contents = await readApprovedFinderExport(finderDir, path);
    validateUpload(contents, "finder");
    const modified = (await stat(path)).mtimeMs / 1000;
    return [
      modified,
      {
        path,
        displayName: basename(path),
        date: fileDate(modified),
        traceCount: traceCount(contents, "finder"),
        kind: "finder",
      },
    ];
  } catch {
    return null;
  }
}

/** List safe retained uploads and approved Finder exports, newest first. */
export async function recentTraceFiles(
  runsDir: string,
  finderDir: string,
): Promise<RecentTraceFile[]> {
  await cleanupExpiredUploads(runsDir);
  const entries: Entry[] = [];
  const directory = uploadsDir(runsDir);
  const directoryInfo = await lstatOrNull(directory);
  if (directoryInfo && !directoryInfo.isSymbolicLink())
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const kind = uploadKind(path);
      if (kind === null) continue;
      const entry = await recentUploadEntry(runsDir, path, kind);
      if (entry) entries.push(entry);
    }
  const finderInfo = await lstatOrNull(finderDir);
  if (finderInfo && !finderInfo.isSymbolicLink())
    for (const name of await readdir(finderDir)) {
      if (!name.endsWith(".json")) continue;
      const entry = await recentFinderEntry(finderDir, join(finderDir, name));
      if (entry) entries.push(entry);
    }
  entries.sort((a, b) =>
    a[0] !== b[0] ? b[0] - a[0] : b[1].path < a[1].path ? -1 : 1,
  );
  return entries.map(([, entry]) => entry);
}

/** Read an uploaded file in bounded chunks, then classify and validate it. */
export async function receiveUpload(
  upload: Blob,
): Promise<[UploadKind, Uint8Array]> {
  const reader = upload.stream().getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_INSIGHTS_UPLOAD_BYTES) {
      await reader.cancel();
      throw new UploadTooLargeError("Upload exceeds the 100 MB size limit.");
    }
    chunks.push(value);
  }
  const contents = Buffer.concat(chunks);
  return [validateUpload(contents), contents];
}

/** Reject a request body larger than an upload plus multipart overhead before parsing it. */
export function limitRequestBody(request: Request): Request {
  const limit = MAX_INSIGHTS_UPLOAD_BYTES + MAX_MULTIPART_OVERHEAD_BYTES;
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > limit)
    throw new UploadRequestTooLargeError(SNAPSHOT_TOO_LARGE_MESSAGE);
  if (!request.body) return request;
  let consumed = 0;
  const guarded = request.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        consumed += chunk.byteLength;
        if (consumed > limit)
          controller.error(
            new UploadRequestTooLargeError(SNAPSHOT_TOO_LARGE_MESSAGE),
          );
        else controller.enqueue(chunk);
      },
    }) as unknown as Parameters<ReadableStream<Uint8Array>["pipeThrough"]>[0],
  );
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: guarded,
    duplex: "half",
  } as RequestInit);
}
