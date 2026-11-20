import { expect, test } from "bun:test";

import {
  encodeRef,
  renderSessionResults,
} from "../../../src/lib/dashboard/insights-sessions-views.js";
import type { SessionSummary } from "../../../src/lib/local-sessions/models.js";

const summary = (update: Partial<SessionSummary> = {}): SessionSummary => ({
  source: "claude-code",
  path: "/sessions/a.jsonl",
  sessionId: "a",
  title: "Fix the <build>",
  projectDir: "/work/app",
  startedAt: new Date("2026-09-01T08:00:00Z"),
  updatedAt: new Date("2026-09-01T09:30:15Z"),
  sizeBytes: 2048,
  firstPrompt: "",
  agentVersion: "1",
  ...update,
});

const result = (sessions: SessionSummary[], complete = true) => ({
  sessions,
  scannedFiles: 3,
  candidateFiles: 9,
  complete,
});

test("rows escape titles, keep selections checked and show UTC times", () => {
  const first = summary();
  const second = summary({ path: "/sessions/b.jsonl", title: "" });
  const html = renderSessionResults(result([first, second]), {
    selected: new Set([encodeRef(first)]),
    rootsFound: true,
  });
  expect(html).toContain("Fix the &lt;build&gt;");
  expect(html).not.toContain("<build>");
  expect(html).toContain(`value="claude-code:/sessions/a.jsonl" checked`);
  expect(html).toContain("(untitled)");
  expect(html).toContain(
    '<time data-utc="2026-09-01T09:30:15">2026-09-01 09:30 UTC</time>',
  );
  expect(html).toContain("2 sessions</span>");
  expect(html).toContain("1 selected");
});

test("empty states tell missing folders from no matches", () => {
  expect(
    renderSessionResults(result([]), { selected: new Set(), rootsFound: true }),
  ).toContain("No local sessions match these filters.");
  expect(
    renderSessionResults(result([]), {
      selected: new Set(),
      rootsFound: false,
    }),
  ).toContain("session folders were found on this computer");
});

test("a cut-short search names how much it scanned and the deadline", () => {
  const html = renderSessionResults(result([summary()], false), {
    selected: new Set(),
    rootsFound: true,
  });
  expect(html).toContain(
    "Searched 3 of 9 session files before the 20-second limit.",
  );
});
