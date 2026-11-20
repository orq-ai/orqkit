import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";

import { OtelTrace } from "../../../src/lib/formats/otel.js";

const goldens = JSON.parse(
  readFileSync(
    new URL("../fixtures/otel-conversion-python-goldens.json", import.meta.url),
    "utf8",
  ),
) as {
  cases: {
    input: unknown;
    raw: boolean;
    options: { agent_name?: string; agent_version?: string };
    ok: boolean;
    expected: Record<string, unknown> | null;
    roundtrip: Record<string, unknown> | null;
  }[];
};
function semanticJsonAttributes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semanticJsonAttributes);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        if (key.startsWith("evaluatorq.atif.") && typeof item === "string") {
          try {
            return [key, JSON.parse(item)];
          } catch {}
        }
        return [key, semanticJsonAttributes(item)];
      }),
    );
  return value;
}
let warn: ReturnType<typeof spyOn<typeof console, "warn">>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());
for (const [i, row] of goldens.cases.entries())
  test(`Python OTel to ATIF and back ${i}`, () => {
    const convert = () => {
      const trace = row.raw
        ? OtelTrace.fromOrq(row.input as Record<string, unknown>[])
        : new OtelTrace(row.input as { spans: unknown[] });
      const atif = trace.toAtif({
        agentName: row.options.agent_name,
        agentVersion: row.options.agent_version,
      });
      return { atif, roundtrip: atif.toOtel() };
    };
    if (!row.ok) expect(convert).toThrow();
    else {
      const { atif, roundtrip } = convert();
      expect(atif.toModelDict()).toEqual(
        row.expected as Record<string, unknown>,
      );
      expect(semanticJsonAttributes(roundtrip.toModelDict())).toEqual(
        semanticJsonAttributes(row.roundtrip),
      );
    }
  });
