import { isClaudeSessionPath, parseClaude, summarizeClaude } from "./claude.js";
import { isCodexSessionPath, parseCodex, summarizeCodex } from "./codex.js";
import type { ParsedSession, SessionFamily, SessionSummary } from "./models.js";
import { isOmpSessionPath, parseOmp, summarizeOmp } from "./omp.js";

export interface SessionReader {
  isSessionPath(path: string, root: string): boolean;
  summarize(path: string): Promise<SessionSummary | null>;
  parse(path: string, summary: SessionSummary): Promise<ParsedSession>;
}
export const READERS: Readonly<Record<SessionFamily, SessionReader>> = {
  claude: {
    isSessionPath: isClaudeSessionPath,
    summarize: summarizeClaude,
    parse: parseClaude,
  },
  codex: {
    isSessionPath: isCodexSessionPath,
    summarize: summarizeCodex,
    parse: parseCodex,
  },
  omp: {
    isSessionPath: isOmpSessionPath,
    summarize: summarizeOmp,
    parse: parseOmp,
  },
};
