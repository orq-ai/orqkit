import type { Dirent } from "node:fs";
import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import { blocksText } from "./items.js";
import {
  FAMILY_OF,
  MAX_SELECTED_SESSIONS,
  MAX_SESSION_TEXT_CHARS,
  SEARCH_DEADLINE_MS,
  SESSION_SOURCES,
  type SessionFamily,
  SessionLoadError,
  type SessionQuery,
  type SessionSearchResult,
  type SessionSummary,
} from "./models.js";
import { READERS, type SessionReader } from "./readers.js";
import { sessionRoots } from "./roots.js";

const cache = new Map<string, SessionSummary | null>(),
  maxCache = 50000;
export function clearSummaryCache(): void {
  cache.clear();
}
const inside = (path: string, root: string): boolean => {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
};
async function actual(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    const absolute = resolve(path),
      parent = dirname(absolute);
    return parent === absolute
      ? absolute
      : join(await actual(parent), basename(absolute));
  }
}
async function mainRepo(directory: string): Promise<string | null> {
  try {
    const first =
      (await readFile(join(directory, ".git"), "utf8")).split(/\r?\n/, 1)[0] ??
      "";
    if (!first.startsWith("gitdir:")) return null;
    const gitdir = resolve(directory, first.slice(7).trim());
    return dirname(gitdir).endsWith(`${sep}.git${sep}worktrees`)
      ? dirname(dirname(dirname(gitdir)))
      : null;
  } catch {
    return null;
  }
}
export async function projectMatches(
  projectDir: string,
  base: string,
): Promise<boolean> {
  if (!projectDir || !base) return false;
  let root = await actual(base);
  root = await actual((await mainRepo(root)) ?? root);
  const project = await actual(projectDir);
  if (inside(project, root)) return true;
  const repo = await mainRepo(project);
  return repo !== null && inside(await actual(repo), root);
}
async function* walk(
  root: string,
  stopped: () => boolean,
): AsyncGenerator<string> {
  const stack = [root];
  while (stack.length && !stopped()) {
    const dir = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (stopped()) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield path;
    }
  }
}
async function mayContain(
  path: string,
  text: string,
  stopped: () => boolean,
): Promise<boolean | null> {
  if (stopped()) return null;
  if (!Array.from(text).every((char) => (char.codePointAt(0) ?? 0) <= 127))
    return true;
  const file = await open(path, "r"),
    needle = text.toLowerCase(),
    needles = [needle, JSON.stringify(needle).slice(1, -1)],
    overlap = Math.max(...needles.map((value) => value.length)) - 1;
  let carry = "";
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    while (true) {
      if (stopped()) return null;
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) return false;
      const window =
        carry + buffer.subarray(0, bytesRead).toString("latin1").toLowerCase();
      if (needles.some((value) => window.includes(value))) return true;
      carry = overlap > 0 ? window.slice(-overlap) : "";
    }
  } finally {
    await file.close();
  }
}
export async function searchSessions(
  query: SessionQuery,
  options: { deadlineMs?: number; signal?: AbortSignal } = {},
): Promise<SessionSearchResult> {
  if (
    !Number.isInteger(query.limit) ||
    query.limit < 1 ||
    query.limit > MAX_SELECTED_SESSIONS
  )
    throw new RangeError(
      `limit must be between 1 and ${MAX_SELECTED_SESSIONS}`,
    );
  if (
    query.text !== null &&
    Array.from(query.text).length > MAX_SESSION_TEXT_CHARS
  )
    throw new RangeError(
      `text must be at most ${MAX_SESSION_TEXT_CHARS} characters`,
    );
  if (query.sources.some((source) => !SESSION_SOURCES.includes(source)))
    throw new Error("unknown session source");
  const deadline =
      performance.now() + (options.deadlineMs ?? SEARCH_DEADLINE_MS),
    stopped = () =>
      performance.now() >= deadline || Boolean(options.signal?.aborted);
  const families = (["claude", "codex", "omp"] as SessionFamily[]).filter(
    (family) => query.sources.some((source) => FAMILY_OF[source] === family),
  );
  const candidates: {
    path: string;
    reader: SessionReader;
    mtime: number;
    key: string;
  }[] = [];
  let complete = true;
  for (const family of families)
    for (const root of await sessionRoots(family)) {
      for await (const path of walk(root, stopped)) {
        if (!READERS[family].isSessionPath(path, root)) continue;
        try {
          const info = await stat(path);
          if (query.start && info.mtime < query.start) continue;
          candidates.push({
            path,
            reader: READERS[family],
            mtime: info.mtimeMs,
            key: `${path}:${info.mtimeMs}:${info.size}`,
          });
        } catch (error) {
          console.warn(
            `Skipping unreadable session file ${path}: ${error instanceof Error ? error.name : "Error"}`,
          );
        }
      }
      if (stopped()) {
        complete = false;
        break;
      }
    }
  candidates.sort((a, b) => b.mtime - a.mtime);
  const matches: SessionSummary[] = [];
  let scanned = 0;
  if (complete)
    for (const candidate of candidates) {
      if (matches.length >= query.limit) break;
      if (stopped()) {
        complete = false;
        break;
      }
      scanned++;
      try {
        let summary = cache.get(candidate.key);
        if (summary === undefined && !cache.has(candidate.key)) {
          summary = await candidate.reader.summarize(candidate.path);
          cache.set(candidate.key, summary);
          if (cache.size > maxCache)
            cache.delete(cache.keys().next().value as string);
        }
        if (
          !summary ||
          !query.sources.includes(summary.source) ||
          (query.start && summary.updatedAt < query.start) ||
          (query.end && summary.startedAt >= query.end)
        )
          continue;
        if (
          query.projectDir &&
          !(await projectMatches(summary.projectDir, query.projectDir))
        )
          continue;
        if (query.text) {
          const maybe = await mayContain(candidate.path, query.text, stopped);
          if (maybe === null) {
            complete = false;
            break;
          }
          if (!maybe) continue;
          const parsed = await candidate.reader.parse(candidate.path, summary),
            needle = query.text.toLowerCase();
          if (
            !parsed.items.some((item) =>
              item.type === "message"
                ? blocksText(item.content).toLowerCase().includes(needle)
                : item.type === "reasoning" &&
                  blocksText(item.summary).toLowerCase().includes(needle),
            )
          )
            continue;
        }
        matches.push(summary);
      } catch (error) {
        if (!(error instanceof SessionLoadError) && !(error instanceof Error))
          throw error;
        console.warn(
          `Skipping session file ${candidate.path}: ${error instanceof Error ? error.name : "Error"}`,
        );
      }
    }
  matches.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  return {
    sessions: matches,
    scannedFiles: scanned,
    candidateFiles: candidates.length,
    complete,
  };
}
