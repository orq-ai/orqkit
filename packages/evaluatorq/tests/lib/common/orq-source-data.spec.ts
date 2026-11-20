import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  FacetSelection,
  NumericFilters,
} from "../../../src/lib/trace-finder/models.js";
import * as data from "../../../src/lib/trace-finder/orq-source-data.js";

const goldens = JSON.parse(
  readFileSync(
    new URL("../fixtures/orq-source-data-python-goldens.json", import.meta.url),
    "utf8",
  ),
) as {
  rows: {
    name: string;
    args: unknown[];
    kwargs: Record<string, unknown>;
    expected: unknown;
    ok: boolean;
  }[];
};
const fns: Record<
  string,
  (args: unknown[], kwargs: Record<string, unknown>) => unknown
> = {
  _metadata_value: (args) =>
    data.metadataValue(args[0], args[1], ...(args.slice(2) as string[])),
  _numeric_metadata: (args, kwargs) =>
    data.numericMetadata(args, String(kwargs.name)),
  _raw_trace_summaries: (args) => data.rawTraceSummaries(args[0]),
  build_oql: (args, kwargs) =>
    data.buildOql(
      new FacetSelection(args[0]),
      new NumericFilters(args[1]),
      args[2] as Record<string, string>,
      {
        traceIds:
          kwargs.trace_ids == null
            ? null
            : new Set(kwargs.trace_ids as string[]),
      },
    ),
  _tool_names: (args) => data.toolNames(...args),
  _metadata_label: (args) => data.metadataLabel(args[0]),
  _tool_definition_size: (args) => data.toolDefinitionSize(...args),
  _eligible_spans: (args) => data.eligibleSpans(args[0] as unknown[]),
  _content_has_value: (args) => data.contentHasValue(args[0]),
  _content_block_has_value: (args) => data.contentBlockHasValue(args[0]),
  _response_item_text: (args) => data.responseItemText(args[0] as data.Row),
  _message_has_content: (args) => data.messageHasContent(args[0] as data.Row),
  _has_reply: (args) => data.hasReply(args[0] as data.Row[]),
  _normalised_messages: (args, kwargs) =>
    data.normalisedMessages(
      args[0],
      kwargs.default_role as "user" | "assistant" | null | undefined,
    ),
  _conversation_messages: (args) => data.conversationMessages(args[0]),
  _message_list: (args, kwargs) =>
    data.messageList(args[0], kwargs.default_role as string | null | undefined),
  _has_chat_text_parts: (args) => data.hasChatTextParts(args[0]),
  _signal_status: (args) => data.signalStatus(args[0]),
  _selected_span_signal_data: (args) =>
    data.selectedSpanSignalData(args[0], args[1] as data.Row[]),
  _span_tool_call_id: (args) => data.spanToolCallId(args[0]),
  _leading_span_type: (args) => data.leadingSpanType(args[0], args[1]),
  _record: (args) =>
    data.traceRecord(
      args[0],
      args[1],
      args[2],
      args[3],
      args[4] as data.Row[],
      args[5] as Record<string, string>,
    ),
};
let warn: ReturnType<typeof spyOn<typeof console, "warn">>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());
for (const [i, row] of goldens.rows.entries())
  test(`Python trace source helper ${i} ${row.name}`, () => {
    const fn = fns[row.name];
    if (!fn) throw new Error(`Missing helper ${row.name}`);
    let result: unknown,
      ok = false;
    try {
      result = fn(row.args, row.kwargs);
      ok = true;
    } catch {}
    expect(ok).toBe(row.ok);
    if (ok) {
      const expected =
        row.name === "_record" && row.expected
          ? Object.fromEntries(
              Object.entries(row.expected).map(([key, value]) => [
                key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
                value,
              ]),
            )
          : row.expected;
      expect<unknown>(result).toEqual(expected);
    }
  });
test("target selection rejects cross-project duplicates and preserves raw coverage flags", () => {
  const summaries = [
      { trace_id: "a", project_id: "other" },
      { trace_id: "a", project_id: "p" },
      { trace_id: "b", project_id: "p" },
      { trace_id: "c", project_id: "p" },
    ],
    raw = new Map<string, unknown>([
      ["b", { trace_id: "b", project_id: "p", attributes: { keep: true } }],
    ]),
    seen = new Set<string>(),
    result = data.selectSummaries(summaries, raw, seen, "p");
  expect(result.rejected).toBe(1);
  expect(
    result.selected.map(([, value, missing]) => [
      data.field(value, "trace_id"),
      missing,
    ]),
  ).toEqual([
    ["b", false],
    ["c", true],
  ]);
  expect([...seen]).toEqual(["a", "b", "c"]);
  expect(data.matchingTargets(result.selected, new Set(["c"]))).toEqual([
    result.selected[1] as data.SelectedSummary,
  ]);
});
test("trace windows retain microseconds and targeted incompleteness remains explicit", () => {
  const now = new Date("2026-11-10T10:00:00.123Z");
  expect(data.checkWindow(null, null, 1, now)).toEqual([
    "2026-11-03T10:00:00.123000Z",
    "2026-11-10T10:00:00.123000Z",
  ]);
  expect(data.checkWindow(null, "2026-11-10T10:00:00.123456+01:00", 1)).toEqual(
    ["2026-11-03T09:00:00.123456Z", "2026-11-10T09:00:00.123456Z"],
  );
  expect(() => data.checkWindow("2026-11-10T10:00:00", null, 1)).toThrow(
    "timezone offset",
  );
  expect(() => data.checkWindow(null, null, 0)).toThrow("at least 1");
  expect(() =>
    data.requireCompleteTargetedLoad(
      {
        captureMetadata: { incomplete_reason: "target_deadline" },
      } as unknown as import("../../../src/lib/trace-finder/models.js").Snapshot,
      { errorType: data.OrqSourceError, operation: "Reload" },
    ),
  ).toThrow("Reload was incomplete: target_deadline");
});
