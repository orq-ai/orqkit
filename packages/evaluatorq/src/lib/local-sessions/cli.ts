import { writePrivateAtomic } from "../common/private-files.js";
import {
  SESSION_SOURCES,
  type SessionQuery,
  type SessionSource,
} from "./models.js";
import { searchSessions } from "./search.js";
import { buildSessionSnapshot } from "./snapshot.js";

export interface SessionArguments {
  source?: string[];
  from?: string;
  to?: string;
  projectDir?: string;
  text?: string;
  limit?: number;
  json?: boolean;
  export?: string;
}
function day(value: string | undefined, next: boolean): Date | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error("session date must be YYYY-MM-DD");
  const year = Number(match[1]),
    month = Number(match[2]),
    date = Number(match[3]);
  const result = new Date(0);
  result.setFullYear(year, month - 1, date);
  result.setHours(0, 0, 0, 0);
  if (
    year < 1 ||
    result.getFullYear() !== year ||
    result.getMonth() !== month - 1 ||
    result.getDate() !== date
  )
    throw new Error("invalid session date");
  if (next) result.setDate(result.getDate() + 1);
  return result;
}
export function sessionQuery(
  args: SessionArguments,
  defaultLimit = 50,
): SessionQuery {
  const requested = args.source?.length ? args.source : [...SESSION_SOURCES];
  if (
    requested.some(
      (source) => !SESSION_SOURCES.includes(source as SessionSource),
    )
  )
    throw new Error("unknown session source");
  const start = day(args.from, false),
    end = day(args.to, true);
  if (start && end && start >= end)
    throw new Error("The first day must not be after the last day.");
  return {
    sources: SESSION_SOURCES.filter((source) => requested.includes(source)),
    start,
    end,
    projectDir: args.projectDir ?? null,
    text: args.text || null,
    limit: args.limit ?? defaultLimit,
  };
}
export async function executeSessions(
  args: SessionArguments,
  io: { print: (message: string) => void; warn: (message: string) => void },
): Promise<number> {
  const query = sessionQuery(args, args.export ? 1000 : 50),
    result = await searchSessions(query);
  if (!result.complete)
    io.warn(
      `Searched ${result.scannedFiles} of ${result.candidateFiles} session files before the time limit; narrow the search to see the rest.`,
    );
  if (args.json) io.print(JSON.stringify(result.sessions, null, 2));
  else if (!result.sessions.length) io.print("No local sessions match.");
  else
    for (const session of result.sessions)
      io.print(
        `${session.updatedAt.toISOString()}\t${session.source}\t${session.projectDir}\t${(session.title || session.firstPrompt).replaceAll("\n", " ").slice(0, 60)}\t${session.path}`,
      );
  if (args.export) {
    if (!result.sessions.length) throw new Error("no sessions to export");
    if (!result.complete)
      io.warn(
        "The export is partial: it holds only sessions found before the search stopped.",
      );
    const snapshot = await buildSessionSnapshot(
      result.sessions.map((session) => ({
        source: session.source,
        path: session.path,
      })),
    );
    await writePrivateAtomic(args.export, snapshot.data, {
      privateDirectory: false,
    });
    io.warn(
      `Wrote ${snapshot.nSessions} ${snapshot.nSessions === 1 ? "session" : "sessions"} to ${args.export}`,
    );
    for (const [, reason] of snapshot.failed) io.warn(`Skipped ${reason}`);
  }
  return 0;
}
