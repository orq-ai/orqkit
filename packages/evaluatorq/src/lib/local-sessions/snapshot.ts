import { traceDocumentJson } from "../common/trace-document.js";
import {
  MAX_SELECTED_SESSIONS,
  SessionLoadError,
  type SessionRef,
} from "./models.js";
import { loadSessionDocument } from "./selection.js";

export class SnapshotTooLarge extends Error {
  override readonly name = "SnapshotTooLarge";
}
export interface FrozenSnapshot {
  data: Buffer;
  nSessions: number;
  failed: [SessionRef, string][];
}
export async function buildSessionSnapshot(
  refs: readonly SessionRef[],
  options: { maxBytes?: number } = {},
): Promise<FrozenSnapshot> {
  if (refs.length > MAX_SELECTED_SESSIONS)
    throw new SessionLoadError(
      `at most ${MAX_SELECTED_SESSIONS} sessions can be selected, got ${refs.length}`,
    );
  const documents = new Map<string, { ended: number; json: Buffer }>(),
    failed: [SessionRef, string][] = [];
  let total = 0,
    duplicates = 0;
  for (const ref of refs) {
    let document: Awaited<ReturnType<typeof loadSessionDocument>>;
    try {
      document = await loadSessionDocument(ref);
    } catch (error) {
      if (!(error instanceof SessionLoadError)) throw error;
      failed.push([ref, error.message]);
      console.warn(`Skipping local session ${ref.path}: ${error.name}`);
      continue;
    }
    const end = Date.parse(String(document.captureMetadata.end)),
      previous = documents.get(document.traceId);
    if (previous) {
      duplicates++;
      if (end <= previous.ended) continue;
      total -= previous.json.length;
    }
    const json = Buffer.from(traceDocumentJson(document));
    documents.set(document.traceId, { ended: end, json });
    total += json.length;
    if (options.maxBytes !== undefined && total > options.maxBytes)
      throw new SnapshotTooLarge();
  }
  if (duplicates)
    console.warn(
      `Dropped ${duplicates} duplicate local sessions that share a trace id`,
    );
  if (!documents.size)
    throw new SessionLoadError(
      `none of the ${refs.length} selected sessions could be loaded`,
    );
  const data = Buffer.concat([
    Buffer.from('{"traces":[],"documents":['),
    ...[...documents.values()].flatMap((value, index) =>
      index ? [Buffer.from(","), value.json] : [value.json],
    ),
    Buffer.from(
      `],"capture_metadata":{"source":"local-sessions","sessions":${documents.size}}}`,
    ),
  ]);
  if (options.maxBytes !== undefined && data.length > options.maxBytes)
    throw new SnapshotTooLarge();
  return { data, nSessions: documents.size, failed };
}
