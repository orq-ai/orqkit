import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";

import {
  flattenAttributes,
  OtelSpan,
  OtelTrace,
  orderSpans,
  parsePart,
  parseTime,
  spanUsage,
} from "../../../src/lib/formats/otel.js";
import goldens from "../fixtures/otel-python-goldens.json" with {
  type: "json",
};

let warn: ReturnType<typeof spyOn<typeof console, "warn">>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());
const nativePart = (value: Record<string, unknown>) => {
  const fields =
    value.type === "file"
      ? ["mime_type", "file_id"]
      : ["blob", "uri"].includes(String(value.type))
        ? ["mime_type"]
        : value.type === "server_tool_call"
          ? ["server_tool_call"]
          : value.type === "server_tool_call_response"
            ? ["server_tool_call_response"]
            : [];
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => [
      fields.includes(key)
        ? key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
        : key,
      v,
    ]),
  );
};
for (const [i, row] of goldens.parts.entries())
  test(`Python OTel part ${i}`, () => {
    const parse = () => parsePart(row.input);
    if (!row.ok) expect(parse).toThrow();
    else
      expect<unknown>(parse()).toEqual(
        nativePart(row.expected as Record<string, unknown>),
      );
  });
for (const [i, row] of goldens.times.entries())
  test(`Python OTel time ${i}`, () =>
    expect(parseTime(row.input)).toBe(row.expected));
for (const [i, row] of goldens.spans.entries())
  test(`Python OTel span validation ${i}`, () => {
    const parse = () => new OtelSpan(row.input);
    if (!row.ok) expect(parse).toThrow();
    else
      expect(parse().toModelDict()).toEqual(
        row.expected as Record<string, unknown>,
      );
  });
for (const [i, row] of goldens.raw.entries())
  test(`Python raw Orq span trace ${i}`, () => {
    const parse = () => OtelTrace.fromOrq(row.input);
    if (!row.ok) expect(parse).toThrow();
    else {
      const trace = parse();
      expect(trace.toModelDict()).toEqual(
        row.expected as Record<string, unknown>,
      );
      expect(trace.roots().map((s) => s.spanId)).toEqual(row.roots as string[]);
      expect(
        Object.fromEntries(
          trace.spans.map((s) => [
            s.spanId,
            trace.children(s.spanId).map((c) => c.spanId),
          ]),
        ),
      ).toEqual(row.children as unknown as Record<string, string[]>);
      expect<unknown>(trace.spans.map((s) => spanUsage(s))).toEqual(
        (row.usage ?? []).map((v) =>
          Object.fromEntries(
            Object.entries(v).map(([k, x]) => [
              k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
              x,
            ]),
          ),
        ),
      );
      expect(
        orderSpans(trace.spans, { fallbackEnd: true }).map((s) => s.spanId),
      ).toEqual(row.ordered as string[]);
    }
  });
for (const [i, row] of goldens.flatten.entries())
  test(`Python OTel attribute flattening ${i}`, () =>
    expect(flattenAttributes(row.input)).toEqual(row.expected));
