import { open, readFile, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";

import { parseIso } from "../formats/time.js";
import {
  type ParsedSession,
  SessionLoadError,
  type SessionSource,
  type SessionSummary,
} from "./models.js";

export const HEAD_BYTES = 262144;
export const TAIL_BYTES = 262144;
export const TEXT_CHARS = 200;
export type SessionRecord = Record<string, unknown>;
function decode(lines: readonly Buffer[]): {
  records: SessionRecord[];
  skipped: number;
} {
  const records: SessionRecord[] = [];
  let skipped = 0;
  for (const raw of lines) {
    const text = raw.toString("utf8").trim();
    if (!text) continue;
    try {
      const record: unknown = JSON.parse(text);
      if (
        record !== null &&
        typeof record === "object" &&
        !Array.isArray(record)
      )
        records.push(record as SessionRecord);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { records, skipped };
}
function splitLines(data: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < data.length; i++)
    if (data[i] === 10) {
      lines.push(data.subarray(start, i));
      start = i + 1;
    }
  lines.push(data.subarray(start));
  return lines;
}
export async function readRecords(
  path: string,
): Promise<{ records: SessionRecord[]; skipped: number }> {
  const lines = splitLines(await readFile(path)),
    tail = lines.pop() as Buffer,
    result = decode(lines);
  if (tail.toString("utf8").trim()) {
    try {
      const value: unknown = JSON.parse(tail.toString("utf8"));
      if (value !== null && typeof value === "object" && !Array.isArray(value))
        result.records.push(value as SessionRecord);
      else result.skipped++;
    } catch {}
  }
  return result;
}
export async function readHead(
  path: string,
  maxBytes: number,
): Promise<SessionRecord[]> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes),
      { bytesRead } = await file.read(buffer, 0, maxBytes, 0);
    if (!bytesRead) return [];
    const lines = splitLines(buffer.subarray(0, bytesRead));
    if (bytesRead === maxBytes) lines.pop();
    return decode(lines).records;
  } finally {
    await file.close();
  }
}
export async function readTail(
  path: string,
  maxBytes: number,
): Promise<SessionRecord[]> {
  const file = await open(path, "r");
  try {
    const size = (await file.stat()).size,
      start = Math.max(0, size - maxBytes),
      buffer = Buffer.alloc(size - start);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start),
      lines = splitLines(buffer.subarray(0, bytesRead));
    if (start > 0) lines.shift();
    return decode(lines).records;
  } finally {
    await file.close();
  }
}

export interface SummaryParts {
  source: SessionSource;
  sessionId: string;
  title: string;
  projectDir: string;
  started: unknown;
  firstPrompt: string;
  agentVersion: string;
}
function timestamp(value: unknown, fallback: Date): Date {
  if (typeof value !== "string" || !value) return fallback;
  try {
    const parsed = parseIso(value);
    return new Date(parsed.epochSeconds * 1000);
  } catch {
    return fallback;
  }
}
export async function summarizeSession(
  path: string,
  extract: (
    head: SessionRecord[],
    tail: SessionRecord[],
  ) => SummaryParts | null | Promise<SummaryParts | null>,
): Promise<SessionSummary | null> {
  try {
    const head = await readHead(path, HEAD_BYTES),
      tail = await readTail(path, TAIL_BYTES),
      file = await stat(path),
      parts = await extract(head, tail);
    if (!parts) return null;
    const rawTime = [...tail]
      .reverse()
      .find((item) => typeof item.timestamp === "string")?.timestamp;
    const stem = basename(path, extname(path));
    return {
      source: parts.source,
      path: resolve(path),
      sessionId: parts.sessionId || stem,
      title: Array.from(parts.title).slice(0, TEXT_CHARS).join(""),
      projectDir: parts.projectDir,
      startedAt: timestamp(parts.started, file.mtime),
      updatedAt: timestamp(rawTime, file.mtime),
      sizeBytes: file.size,
      firstPrompt: Array.from(parts.firstPrompt.trim())
        .slice(0, TEXT_CHARS)
        .join(""),
      agentVersion: parts.agentVersion,
    };
  } catch (error) {
    if (error instanceof SessionLoadError) throw error;
    throw new SessionLoadError(
      `${path}: unreadable session (${error instanceof Error ? error.name : "Error"})`,
    );
  }
}
export async function parseSession(
  path: string,
  summary: SessionSummary,
  convert: (records: SessionRecord[]) => {
    items: Record<string, unknown>[];
    model: string;
    totalTokens: number | null;
  },
): Promise<ParsedSession> {
  try {
    const { records, skipped } = await readRecords(path);
    if (skipped) console.warn(`Skipped ${skipped} malformed lines in ${path}`);
    const parsed = convert(records);
    if (!parsed.items.length)
      throw new SessionLoadError(`${path}: no conversation items`);
    return { summary, ...parsed, skippedLines: skipped };
  } catch (error) {
    if (error instanceof SessionLoadError) throw error;
    throw new SessionLoadError(
      `${path}: unreadable session (${error instanceof Error ? error.name : "Error"})`,
    );
  }
}
