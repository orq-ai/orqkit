import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

import { sessionDocument } from "./documents.js";
import {
  FAMILY_OF,
  SessionLoadError,
  type SessionRef,
  type SessionSummary,
} from "./models.js";
import { READERS } from "./readers.js";
import { sessionRoots } from "./roots.js";

const inside = (path: string, root: string): boolean => {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
};
async function resolveSession(
  ref: SessionRef,
): Promise<{ path: string; summary: SessionSummary }> {
  try {
    const path = await realpath(ref.path),
      family = FAMILY_OF[ref.source],
      reader = READERS[family];
    let allowed = false;
    for (const root of await sessionRoots(family)) {
      const actualRoot = await realpath(root);
      if (inside(path, actualRoot) && reader.isSessionPath(path, actualRoot)) {
        allowed = true;
        break;
      }
    }
    if (!allowed)
      throw new SessionLoadError(
        `${ref.path}: not a main session file inside the ${ref.source} session folders`,
      );
    if (!(await stat(path)).isFile())
      throw new SessionLoadError(`${ref.path}: not a file`);
    const summary = await reader.summarize(path);
    if (!summary) throw new SessionLoadError(`${ref.path}: not a main session`);
    if (summary.source !== ref.source)
      throw new SessionLoadError(
        `${ref.path}: source mismatch, the file is a ${summary.source} session`,
      );
    return { path, summary };
  } catch (error) {
    if (error instanceof SessionLoadError) throw error;
    throw new SessionLoadError(
      `${ref.path}: ${error instanceof Error ? error.name : "Error"}`,
    );
  }
}
export async function resolveSessionRef(
  ref: SessionRef,
): Promise<SessionSummary> {
  return (await resolveSession(ref)).summary;
}
export async function loadSessionDocument(ref: SessionRef) {
  const { path, summary } = await resolveSession(ref);
  try {
    return sessionDocument(
      await READERS[FAMILY_OF[ref.source]].parse(path, summary),
    );
  } catch (error) {
    if (error instanceof SessionLoadError) throw error;
    throw new SessionLoadError(
      `${ref.path}: ${error instanceof Error ? error.name : "Error"}`,
    );
  }
}
