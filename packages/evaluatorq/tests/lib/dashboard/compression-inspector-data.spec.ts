import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  capText,
  jevState,
  serializedChars,
} from "../../../src/lib/common/model-input.js";
import {
  ensureTraceDocument,
  TraceDocument,
  toChatMessages,
  traceDocumentJson,
} from "../../../src/lib/common/trace-document.js";
import {
  CompressionKnobs,
  fetchOrqDocument,
  InspectorSourceError,
  jevReductionPercent,
  previewDocument,
  readableReductionPercent,
} from "../../../src/lib/dashboard/compression-inspector-data.js";
import { fullConversationViewWithMessageSpans } from "../../../src/lib/insights/transcript.js";
import { TraceRecord } from "../../../src/lib/trace-finder/models.js";
import {
  type OrqSourceClient,
  OrqTraceSource,
} from "../../../src/lib/trace-finder/orq-source.js";
import { type Fixture, fake } from "../common/orq-source-fake.js";

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"),
  );

interface Golden {
  name: string;
  document_json: string;
  source: string | null;
  form: Record<string, string>;
  preview: Record<string, unknown>;
}

const goldens = fixture("compression-preview-python-goldens.json") as Golden[];
const scratch = mkdtempSync(join(tmpdir(), "compression-preview-"));

for (const [i, c] of goldens.entries())
  test(`preview matches Python: ${c.name}`, async () => {
    const document = new TraceDocument(JSON.parse(c.document_json));
    expect(traceDocumentJson(document)).toBe(c.document_json);
    let sourcePath: string | null = null;
    if (c.source !== null) {
      sourcePath = join(scratch, `source-${i}.jsonl`);
      writeFileSync(sourcePath, c.source, "utf8");
    }
    const knobs = CompressionKnobs.fromForm(c.form);
    expect(
      Object.fromEntries(
        Object.entries(knobs.asForm()).filter(([, value]) => value !== false),
      ),
    ).toEqual(
      Object.fromEntries(
        Object.entries(c.form).map(([key, value]) => [
          key,
          value === "1" && !/chars|edge|total|cap|budget/.test(key)
            ? true
            : /^-?\d+$/.test(value)
              ? Number(value)
              : value,
        ]),
      ),
    );
    const preview = await previewDocument(document, { knobs, sourcePath });
    expect(JSON.parse(JSON.stringify(preview))).toEqual(c.preview);
  });

const makeTrace = (traceId: string, messages: Record<string, unknown>[]) =>
  new TraceRecord({
    schema_version: 1,
    trace_id: traceId,
    span_id: `span-${traceId}`,
    timestamp: "2026-09-01T00:00:00Z",
    messages,
    project: "default",
    model: "gpt-5",
    provider: "openai",
    status: "completed",
    product: "chat",
    trace_type: "conversation",
  });

const withMessages = (contents: string[]) =>
  ensureTraceDocument(
    makeTrace(
      "compression-preview",
      contents.map((content, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content,
      })),
    ),
  );

test("preview renders media markers without fetching urls", async () => {
  const url = "https://example.test/private-image.png";
  const document = ensureTraceDocument(
    makeTrace("media", [
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this" },
          { type: "image_url", image_url: { url } },
        ],
      },
    ]),
  );
  const preview = await previewDocument(document, {
    knobs: CompressionKnobs.defaults(10_000),
  });
  expect(preview.readable).toContain("[image]");
  expect(JSON.stringify(preview.compressed)).toContain("[image, size unknown]");
  expect(preview.readable).not.toContain(url);
  expect(JSON.stringify(preview.compressed)).not.toContain(url);
});

test("preview uses the whole transcript budget beside one Jev state", async () => {
  const document = withMessages(
    Array.from({ length: 20 }, () => "detail ".repeat(100)),
  );
  const before = traceDocumentJson(document);
  const messages = toChatMessages(document);
  const [original, , count] = fullConversationViewWithMessageSpans(document);
  const expected = jevState(messages, { globalCharCap: 4096 });
  const preview = await previewDocument(document, {
    knobs: new CompressionKnobs({ global_char_cap: 4096, budget: 4096 }),
  });
  expect(preview.transcript_chars).toBe(Array.from(String(original)).length);
  expect(preview.readable).toBe(String(capText(original, 4096)[0]));
  expect(preview.readable_chars).toBeLessThanOrEqual(4096);
  expect(preview.readable.startsWith("#0 user:")).toBe(true);
  expect(preview.readable).toMatch(/^#19 assistant:/m);
  expect(preview.readable).toMatch(
    /\[\.\.\. \d+ messages \(\d+-\d+\) left out \.\.\.\]/,
  );
  expect(preview.compressed).toEqual(expected);
  expect(preview.compressed_chars).toBe(serializedChars(expected));
  expect(preview.message_count).toBe(count);
  expect(count).toBe(messages.length);
  expect(preview.omitted_messages).toBeGreaterThan(0);
  expect(preview.transcript_chars).toBeGreaterThan(preview.global_cap);
  expect(preview.compressed_chars).toBeLessThanOrEqual(preview.global_cap);
  expect(traceDocumentJson(document)).toBe(before);
});

test("preview scrubs secrets from both views", async () => {
  const document = withMessages([
    `API_TOKEN=gXeRk29vLq0Pz8Wd ${"context ".repeat(120)}`,
    ...Array.from({ length: 19 }, () => "context ".repeat(120)),
  ]);
  const preview = await previewDocument(document, {
    knobs: new CompressionKnobs({ global_char_cap: 4096, budget: 100_000 }),
  });
  expect(preview.readable_chars).toBe(preview.transcript_chars);
  expect(preview.readable_chars).toBeGreaterThan(preview.global_cap);
  expect(preview.readable).not.toContain("gXeRk29vLq0Pz8Wd");
  expect(JSON.stringify(preview.compressed)).not.toContain("gXeRk29vLq0Pz8Wd");
  expect(preview.compressed_chars).toBeLessThanOrEqual(preview.global_cap);
});

test("reduction uses the full JSON regardless of display and compression caps", async () => {
  const document = withMessages([
    "A readable message. ".repeat(200),
    "A long response. ".repeat(200),
  ]);
  const baseline = Array.from(traceDocumentJson(document)).length;
  const knobs = CompressionKnobs.defaults(10_000);
  const initial = await previewDocument(document, { knobs });
  const reduced = await previewDocument(document, {
    knobs: new CompressionKnobs({
      ...knobs,
      original_view: "readable",
      budget: 1_000,
      jev: { ...knobs.jev, stateChars: 1_500 },
    }),
  });
  expect(initial.full_json_chars).toBe(baseline);
  expect(reduced.full_json_chars).toBe(baseline);
  expect(readableReductionPercent(reduced)).toBeGreaterThan(
    readableReductionPercent(initial),
  );
  expect(jevReductionPercent(reduced)).toBeGreaterThan(
    jevReductionPercent(initial),
  );
  expect(readableReductionPercent(reduced)).toBeCloseTo(
    (100 * (baseline - reduced.readable_chars)) / baseline,
  );
});

test("reduction can be negative when formatting expands the trace", async () => {
  const preview = await previewDocument(withMessages(["short"]), {
    knobs: CompressionKnobs.defaults(10_000),
  });
  const expanded = {
    ...preview,
    readable_chars: preview.full_json_chars * 2,
    compressed_chars: preview.full_json_chars * 3,
  };
  expect(readableReductionPercent(expanded)).toBe(-100);
  expect(jevReductionPercent(expanded)).toBe(-200);
});

test("raw source view is refused for documents without a source file", async () => {
  await expect(
    previewDocument(withMessages(["x"]), {
      knobs: new CompressionKnobs({
        ...CompressionKnobs.defaults(10_000),
        original_view: "source",
      }),
    }),
  ).rejects.toThrow(
    "Original shows: the raw source is only available for local sessions; choose another view.",
  );
});

const START = new Date("2026-09-20T00:00:00Z");
const END = new Date("2026-09-21T00:00:00Z");
const SAFE = "The selected Orq trace could not be loaded.";
const sourceGoldens = fixture("orq-source-python-goldens.json") as {
  cases: { input: Fixture }[];
};

let warn: ReturnType<typeof spyOn<typeof console, "warn">>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

test("fetch loads the targeted trace in the requested window and closes the source", async () => {
  const input = sourceGoldens.cases[25]?.input as Fixture;
  const { client, calls } = fake(input);
  const close = spyOn(OrqTraceSource.prototype, "close");
  try {
    const document = await fetchOrqDocument(async () => client, "t", {
      start: START,
      end: END,
    });
    expect(document?.traceId).toBe("t");
    expect(String(calls.query.length)).not.toBe("0");
    expect(JSON.stringify(calls.query[0])).toContain('trace_id in (\\"t\\")');
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    close.mockRestore();
  }
});

test("fetch returns null for a trace that is not there", async () => {
  const input = sourceGoldens.cases[25]?.input as Fixture;
  const { client, calls } = fake({
    ...input,
    pages: [{ search: { data: [], has_more: false } }],
  });
  expect(await fetchOrqDocument(async () => client, "not-present")).toBeNull();
  expect(calls.query).toHaveLength(1);
});

test("fetch replaces source failures with one fixed message", async () => {
  const client = {
    _options: {},
    _baseURL: null,
    projects: {
      list: async () => {
        throw new Error("private payload /home/private/path token=secret");
      },
    },
    traces: {
      query: async () => {
        throw new Error("trace=target-id");
      },
    },
  } as unknown as OrqSourceClient;
  const error = await fetchOrqDocument(async () => client, "target-id", {
    start: START,
    end: END,
  }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(InspectorSourceError);
  expect((error as Error).message).toBe(SAFE);
});

test("fetch replaces auth failures with one fixed message", async () => {
  const error = await fetchOrqDocument(async () => {
    throw new Error("selected auth at /private/credentials.json is secret");
  }, "private-trace-id").catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(InspectorSourceError);
  expect((error as Error).message).toBe(SAFE);
  expect((error as Error).cause).toBeInstanceOf(Error);
  expect(((error as Error).cause as Error).message).toContain(
    "/private/credentials.json",
  );
});

test("fetch rejects an inverted or invalid window without the trace id", async () => {
  for (const [start, end] of [
    [END, START],
    [new Date("nope"), END],
  ] as const) {
    const error = await fetchOrqDocument(
      async () => ({}) as OrqSourceClient,
      "sensitive-trace-id",
      { start, end },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InspectorSourceError);
    expect((error as Error).message).not.toContain("sensitive-trace-id");
  }
});
