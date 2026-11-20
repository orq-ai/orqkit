export const SESSION_SOURCES = [
  "claude-code",
  "claude-desktop",
  "codex",
  "omp",
] as const;
export type SessionSource = (typeof SESSION_SOURCES)[number];
export type SessionFamily = "claude" | "codex" | "omp";
export const FAMILY_OF: Readonly<Record<SessionSource, SessionFamily>> = {
  "claude-code": "claude",
  "claude-desktop": "claude",
  codex: "codex",
  omp: "omp",
};
export const MAX_SELECTED_SESSIONS = 1000;
export const SEARCH_DEADLINE_MS = 20000;
export const MAX_SESSION_TEXT_CHARS = 500;
export class SessionLoadError extends Error {
  override readonly name = "SessionLoadError";
}
export interface SessionRef {
  source: SessionSource;
  path: string;
}
export interface SessionSummary extends SessionRef {
  sessionId: string;
  title: string;
  projectDir: string;
  startedAt: Date;
  updatedAt: Date;
  sizeBytes: number;
  firstPrompt: string;
  agentVersion: string;
}
export interface SessionQuery {
  sources: readonly SessionSource[];
  start: Date | null;
  end: Date | null;
  projectDir: string | null;
  text: string | null;
  limit: number;
}
export interface SessionSearchResult {
  sessions: SessionSummary[];
  scannedFiles: number;
  candidateFiles: number;
  complete: boolean;
}
export interface ParsedSession {
  summary: SessionSummary;
  items: Record<string, unknown>[];
  model: string;
  totalTokens: number | null;
  skippedLines: number;
}
