import { afterEach, describe, expect, it, spyOn } from "bun:test";

import {
  detectMessageFormat,
  type FetchLike,
  fetchTraces,
  loadTraces,
  parseMessages,
  partitionTraces,
  traceFromSpans,
} from "../../../src/lib/common/trace-input.js";
import { Trace, TraceInput } from "../../../src/lib/trace.js";

const otel = (role: string, content: string) => [
  { role, parts: [{ type: "text", content }] },
];

const SPANS = [
  {
    span_id: "root",
    start_time: "2026-01-01T00:00:00Z",
    attributes: { "orq.session_id": "s1" },
  },
  {
    span_id: "llm1",
    parent_span_id: "root",
    start_time: "2026-01-01T00:00:01Z",
    attributes: {
      "gen_ai.input.messages": otel("user", "What is 2+2?"),
      "gen_ai.output.messages": otel("assistant", "4"),
    },
  },
  {
    span_id: "eval",
    parent_span_id: "root",
    type: "evaluator",
    start_time: "2026-01-01T00:00:02Z",
    attributes: {
      "gen_ai.input.messages": otel("user", "judge this"),
      "gen_ai.output.messages": otel("assistant", "pass"),
    },
  },
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

interface Call {
  url: string;
  body: Record<string, unknown> | null;
  authorization: string | undefined;
}

function fakeFetch(respond: (call: Call, index: number) => Response) {
  const calls: Call[] = [];
  const fetchFn: FetchLike = async (input, init) => {
    const call: Call = {
      url: input,
      body: init.body ? JSON.parse(String(init.body)) : null,
      authorization: (init.headers as Record<string, string>).Authorization,
    };
    calls.push(call);
    return respond(call, calls.length - 1);
  };
  return { calls, fetchFn };
}

const OPTIONS = { apiKey: "k", baseUrl: "https://host.test/" };

describe("message parsing", () => {
  it("detects each wire format", () => {
    expect(detectMessageFormat([{ role: "user", content: "x" }])).toBe(
      "chat_completions",
    );
    expect(detectMessageFormat([{ role: "user", parts: [] }])).toBe(
      "otel_genai",
    );
    expect(
      detectMessageFormat([
        { type: "function_call", call_id: "c", name: "f", arguments: "{}" },
      ]),
    ).toBe("responses");
  });

  it("normalizes Responses items into chat messages", () => {
    const { messages, format } = parseMessages(
      [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hi" }],
        },
        {
          type: "function_call",
          call_id: "c1",
          name: "f",
          arguments: '{"a":1}',
        },
        { type: "function_call_output", call_id: "c1", output: "done" },
      ],
      { defaultRole: "user" },
    );
    expect(format).toBe("responses");
    expect(messages[0]).toMatchObject({ role: "user", content: "hi" });
    expect(messages[1]?.role).toBe("assistant");
    expect(messages[1]?.tool_calls?.[0]).toMatchObject({
      id: "c1",
      type: "function",
      function: { name: "f", arguments: '{"a":1}' },
    });
    expect(messages[2]).toMatchObject({
      role: "tool",
      content: "done",
      tool_call_id: "c1",
    });
  });
});

describe("traceFromSpans", () => {
  it("picks the last non-evaluator exchange", () => {
    const trace = traceFromSpans("t1", SPANS, {
      traceMetadata: { trace_id: "t1", name: "n1" },
    });
    expect(trace.importError).toBeNull();
    expect(trace.messageSpanId).toBe("llm1");
    expect(trace.messageFormat).toBe("otel_genai");
    expect(trace.query).toBe("What is 2+2?");
    expect(trace.inputMessages.map((m) => m.content)).toEqual(["What is 2+2?"]);
    expect(trace.outputMessages.map((m) => m.content)).toEqual(["4"]);
    expect(trace.metadata).toEqual({ traceName: "n1" });
  });

  it("reads v3 attribute collisions without importing summary metadata", () => {
    const trace = traceFromSpans("t1", [
      {
        span_id: "responses",
        attributes: {
          openresponses: {
            input: {
              _value: [
                {
                  type: "message",
                  role: "user",
                  content: [{ type: "input_text", text: "Reply mango" }],
                },
              ],
              items: { count: 1 },
            },
            output: {
              _value: [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "mango" }],
                },
              ],
              items: { count: 1 },
            },
          },
        },
      },
    ]);
    expect(trace.importError).toBeNull();
    expect(trace.query).toBe("Reply mango");
    expect(trace.inputMessages.map((message) => message.content)).toEqual([
      "Reply mango",
    ]);
    expect(trace.outputMessages.map((message) => message.content)).toEqual([
      "mango",
    ]);
    expect(trace.messageFormat).toBe("responses");
  });

  it("reads wrapped OTel message attributes and ignores count-only attributes", () => {
    const trace = traceFromSpans("t1", [
      {
        span_id: "otel",
        attributes: {
          gen_ai: {
            input: { messages: { _value: otel("user", "Question"), count: 1 } },
            output: {
              messages: { _value: otel("assistant", "Answer"), count: 1 },
            },
          },
        },
      },
    ]);
    expect(trace.query).toBe("Question");
    expect(trace.outputMessages.map((message) => message.content)).toEqual([
      "Answer",
    ]);
    expect(trace.messageFormat).toBe("otel_genai");
    const empty = traceFromSpans("t1", [
      {
        span_id: "empty",
        attributes: {
          openresponses: {
            input: { _value: [], items: { count: 0 } },
            output: { _value: [], items: { count: 0 } },
          },
        },
      },
    ]);
    expect(empty.importError).not.toBeNull();
  });

  it("records an import error for an empty trace", () => {
    const trace = traceFromSpans("t1", []);
    expect(trace.importError).toBe("the trace has no spans.");
    expect(trace.inputMessages).toEqual([]);
  });

  it("records an import error for an unknown requested span", () => {
    const trace = traceFromSpans("t1", SPANS, { requestedSpanId: "nope" });
    expect(trace.requestedSpanId).toBe("nope");
    expect(trace.importError).toBe("requested span 'nope' was not found.");
  });
});

const WINDOW = {
  startTime: "2026-01-01T00:00:00Z",
  endTime: "2026-01-02T00:00:00Z",
};

function spanFixture(call: Call, spans = SPANS): Response {
  const url = new URL(call.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const traceId = decodeURIComponent(parts[2] as string);
  const summary = (span: (typeof SPANS)[number]) => {
    const { attributes: _attributes, ...fields } = span;
    return { ...fields, trace_id: traceId, has_detail: false };
  };
  if (parts.length === 4 && parts[3] === "spans")
    return json({ object: "list", data: spans.map(summary), has_more: false });
  if (parts.length === 5 && parts[3] === "spans") {
    const span = spans.find(
      (item) => item.span_id === decodeURIComponent(parts[4] as string),
    );
    if (span)
      return json({
        span: { summary: summary(span), attributes: span.attributes },
      });
  }
  throw new Error(`Unexpected fixture request ${call.url}`);
}

describe("fetchTraces v3", () => {
  afterEach(() => {
    delete process.env.ORQ_API_KEY;
  });

  it("requires an API key", async () => {
    delete process.env.ORQ_API_KEY;
    await expect(
      fetchTraces(new TraceInput({ traceId: "t1" })),
    ).rejects.toThrow("Missing Orq API key");
  });

  it("hydrates every span and URL-encodes trace and span ids", async () => {
    const spans = SPANS.map((span) =>
      span.span_id === "llm1" ? { ...span, span_id: "llm/one" } : span,
    );
    const { calls, fetchFn } = fakeFetch((call) => spanFixture(call, spans));
    const [trace] = await fetchTraces(
      new TraceInput({ traceId: "a/b", spanId: "llm/one" }),
      { ...OPTIONS, fetchFn },
    );
    expect(calls).toHaveLength(1 + spans.length);
    expect(calls[0]?.url).toBe(
      "https://host.test/v3/traces/a%2Fb/spans?limit=200",
    );
    expect(calls.some((call) => call.url.endsWith("/spans/llm%2Fone"))).toBe(
      true,
    );
    expect(calls.every((call) => call.authorization === "Bearer k")).toBe(true);
    expect(trace?.importError).toBeNull();
    expect(trace?.traceId).toBe("a/b");
    expect(trace?.messageSpanId).toBe("llm/one");
    expect(trace?.sessionId).toBe("s1");
    expect(trace?.outputMessages[0]?.content).toBe("4");
  });

  it("uses v3 filters, ISO windows and cursor pagination", async () => {
    const { calls, fetchFn } = fakeFetch((call) => {
      if (!call.url.endsWith("/v3/traces/search")) return spanFixture(call);
      return call.body?.page_token === undefined
        ? json({
            data: [{ trace_id: "a" }, { trace_id: "b" }],
            has_more: true,
            next_page_token: "next/one",
          })
        : json({
            data: [{ trace_id: "c", thread_id: "thread-c" }],
            has_more: false,
          });
    });
    const filters = [{ field: "status", op: "eq" as const, values: ["error"] }];
    const traces = await fetchTraces(
      new TraceInput({ ...WINDOW, limit: 3, search: "q", filters }),
      { ...OPTIONS, fetchFn },
    );
    const lists = calls.filter((call) =>
      call.url.endsWith("/v3/traces/search"),
    );
    expect(lists.map((call) => call.body?.limit)).toEqual([3, 1]);
    expect(lists[0]?.body).toEqual({
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-02T00:00:00.000Z",
      filter_operator: "and",
      filters,
      query: "q",
      limit: 3,
    });
    expect(lists[1]?.body?.page_token).toBe("next/one");
    expect(traces.map((trace) => trace.traceId)).toEqual(["a", "b", "c"]);
    expect(traces[2]?.threadId).toBe("thread-c");
  });

  it("reads every span page before normalizing an exchange", async () => {
    const { calls, fetchFn } = fakeFetch((call) => {
      const url = new URL(call.url);
      if (url.pathname.endsWith("/spans"))
        return json(
          url.searchParams.has("page_token")
            ? {
                data: SPANS.slice(1).map(
                  ({ attributes: _attributes, ...summary }) => summary,
                ),
                has_more: false,
              }
            : {
                data: [{ span_id: "root" }],
                has_more: true,
                next_page_token: "span/next",
              },
        );
      return spanFixture(call);
    });
    const [trace] = await fetchTraces(new TraceInput({ traceId: "t1" }), {
      ...OPTIONS,
      fetchFn,
    });
    expect(
      calls.filter((call) => new URL(call.url).pathname.endsWith("/spans")),
    ).toHaveLength(2);
    expect(calls[1]?.url).toContain("page_token=span%2Fnext");
    expect(trace?.messageSpanId).toBe("llm1");
    expect(trace?.outputMessages[0]?.content).toBe("4");
  });

  it.each([{}, { startTime: WINDOW.startTime }, { endTime: WINDOW.endTime }])(
    "requires both search bounds before any request: %j",
    async (bounds) => {
      const { calls, fetchFn } = fakeFetch(() => json({ data: [] }));
      await expect(
        fetchTraces(new TraceInput(bounds), { ...OPTIONS, fetchFn }),
      ).rejects.toThrow("requires both startTime and endTime");
      expect(calls).toHaveLength(0);
    },
  );

  it("retries a 5xx on the span fetch", async () => {
    const { calls, fetchFn } = fakeFetch((call, index) =>
      index === 0 ? new Response("nope", { status: 503 }) : spanFixture(call),
    );
    const [trace] = await fetchTraces(new TraceInput({ traceId: "t1" }), {
      ...OPTIONS,
      fetchFn,
    });
    expect(calls).toHaveLength(2 + SPANS.length);
    expect(trace?.importError).toBeNull();
  }, 20_000);

  it("keeps requested-span provenance when a span list is unreadable", async () => {
    const { fetchFn } = fakeFetch(() => json({ not: "a list" }));
    const [trace] = await fetchTraces(
      new TraceInput({ traceId: "t1", spanId: "s1" }),
      { ...OPTIONS, fetchFn },
    );
    expect(trace?.importError).toContain("invalid list payload");
    expect(trace?.requestedSpanId).toBe("s1");
    expect(trace?.messages).toEqual([]);
  });

  it.each(["missing", "repeated"])(
    "rejects a %s search cursor instead of returning partial rows",
    async (mode) => {
      let page = 0;
      const { fetchFn } = fakeFetch(() =>
        json({
          data: [{ trace_id: String(page++) }],
          has_more: true,
          ...(mode === "repeated" ? { next_page_token: "same" } : {}),
        }),
      );
      await expect(
        fetchTraces(new TraceInput({ ...WINDOW, limit: 3 }), {
          ...OPTIONS,
          fetchFn,
        }),
      ).rejects.toThrow(
        mode === "missing" ? "no next_page_token" : "repeated a page token",
      );
    },
  );

  it("does not normalize a partial span list", async () => {
    const { fetchFn } = fakeFetch(() =>
      json({ data: [{ span_id: "root" }], has_more: true }),
    );
    const [trace] = await fetchTraces(new TraceInput({ traceId: "t1" }), {
      ...OPTIONS,
      fetchFn,
    });
    expect(trace?.importError).toContain("refusing a partial import");
    expect(trace?.messages).toEqual([]);
  });

  it("rejects a mismatched span detail", async () => {
    const { fetchFn } = fakeFetch((call) =>
      new URL(call.url).pathname.endsWith("/spans")
        ? spanFixture(call)
        : json({ span: { summary: { span_id: "another" }, attributes: {} } }),
    );
    const [trace] = await fetchTraces(new TraceInput({ traceId: "t1" }), {
      ...OPTIONS,
      fetchFn,
    });
    expect(trace?.importError).toContain("mismatched detail");
  });

  it("isolates a failed detail to its trace", async () => {
    const { fetchFn } = fakeFetch((call) => {
      if (call.url.endsWith("/search"))
        return json({ data: [{ trace_id: "a" }, { trace_id: "b" }] });
      if (call.url.endsWith("/a/spans/llm1"))
        return new Response("not found", { status: 404 });
      return spanFixture(call);
    });
    const traces = await fetchTraces(new TraceInput({ ...WINDOW }), {
      ...OPTIONS,
      fetchFn,
    });
    expect(traces[0]?.importError).toContain("HTTP 404");
    expect(traces[1]?.importError).toBeNull();
    expect(traces[1]?.outputMessages[0]?.content).toBe("4");
  });

  it("deduplicates overlapping search pages without losing a requested row", async () => {
    const { fetchFn } = fakeFetch((call) =>
      call.url.endsWith("/search")
        ? json(
            call.body?.page_token
              ? { data: [{ trace_id: "b" }, { trace_id: "c" }] }
              : {
                  data: [{ trace_id: "a" }, { trace_id: "b" }],
                  has_more: true,
                  next_page_token: "next",
                },
          )
        : spanFixture(call),
    );
    const traces = await fetchTraces(new TraceInput({ ...WINDOW, limit: 3 }), {
      ...OPTIONS,
      fetchFn,
    });
    expect(traces.map((trace) => trace.traceId)).toEqual(["a", "b", "c"]);
  });

  it("warns when a query matches nothing", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { fetchFn } = fakeFetch(() => json({ data: [], has_more: false }));
      expect(
        await fetchTraces(new TraceInput({ ...WINDOW, limit: 2 }), {
          ...OPTIONS,
          fetchFn,
        }),
      ).toEqual([]);
      expect(String(warn.mock.calls[0]?.[0])).toContain("matched no traces");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("partitionTraces and loadTraces", () => {
  const good = new Trace({ traceId: "ok" });
  const bad = new Trace({ traceId: "bad", importError: "boom" });

  it("splits usable from failed and names the failures", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    const { usable, failed } = partitionTraces([good, bad], { caller: "sim" });
    expect(usable).toEqual([good]);
    expect(failed).toEqual([bad]);
    expect(String(warn.mock.calls[0]?.[0])).toContain("sim: 1 of 2");
    expect(String(warn.mock.calls[0]?.[0])).toContain("bad: boom");
    warn.mockRestore();
  });

  it("accepts already imported traces without fetching", async () => {
    const batch = await loadTraces([good], { caller: "sim" });
    expect(batch.traces).toEqual([good]);
    expect(batch.usable).toEqual([good]);
    expect(batch.failed).toEqual([]);
  });
});

describe("TraceInput", () => {
  it("rejects invalid combinations", () => {
    expect(() => new TraceInput({ spanId: "s" })).toThrow(
      "spanId requires traceId.",
    );
    expect(() => new TraceInput({ traceId: "t", limit: 3 })).toThrow(
      "traceId cannot be combined with trace search criteria or limit.",
    );
    expect(
      () =>
        new TraceInput({
          startTime: "2026-01-02T00:00:00Z",
          endTime: "2026-01-01T00:00:00Z",
        }),
    ).toThrow("startTime must be before endTime.");
  });

  it("rejects empty v3 windows and legacy filter grammar", () => {
    expect(
      () =>
        new TraceInput({
          startTime: WINDOW.startTime,
          endTime: WINDOW.startTime,
        }),
    ).toThrow("startTime must be before endTime");
    expect(
      () =>
        new TraceInput({
          filters: [
            { field: "status", operator: "eq", value: "error" },
          ] as never,
        }),
    ).toThrow();
  });

  it("reads a time without an offset as UTC", () => {
    const input = new TraceInput({ startTime: "2026-01-01T12:00:00" });
    expect(input.startTime?.getTime()).toBe(Date.UTC(2026, 0, 1, 12));
    expect(input.queryLimit).toBe(20);
  });
});

describe("Trace", () => {
  const m = (role: "user" | "assistant", content: string) => ({
    role,
    content,
    tool_calls: null,
    tool_call_id: null,
    name: null,
  });

  it("removes the largest exact overlap between input and output", () => {
    const trace = new Trace({
      traceId: "t",
      inputMessages: [m("user", "a"), m("assistant", "b")],
      outputMessages: [m("assistant", "b"), m("user", "c")],
    });
    expect(trace.messages.map((x) => x.content)).toEqual(["a", "b", "c"]);
  });

  it("rejects messages on a failed import", () => {
    expect(
      () =>
        new Trace({
          traceId: "t",
          importError: "boom",
          inputMessages: [m("user", "a")],
        }),
    ).toThrow();
  });

  it("builds a datapoint carrying provenance", () => {
    const point = new Trace({
      traceId: "t",
      messageSpanId: "s",
      inputMessages: [m("user", "a")],
      outputMessages: [m("assistant", "b")],
      query: "a",
    }).toDatapoint();
    expect(point.inputs).toMatchObject({
      query: "a",
      sourceTraceId: "t",
      sourceSpanId: "s",
    });
  });

  it("flags a failed import on the datapoint", () => {
    const point = new Trace({
      traceId: "t",
      importError: "boom",
    }).toDatapoint();
    expect(point.inputs.traceImportError).toBe("boom");
  });
});
