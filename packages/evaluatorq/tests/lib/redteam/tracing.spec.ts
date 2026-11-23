import { expect, it } from "bun:test";

it("exports redteam purpose, evaluator jury annotations and per-call usage without duplicate spans", async () => {
  const child = Bun.spawn(
    [
      "bun",
      new URL("../fixtures/redteam-tracing-run.ts", import.meta.url).pathname,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [output, errors, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code) throw new Error(errors + output);
  const result = JSON.parse(output.trim().split("\n").at(-1) ?? "{}");
  type Span = {
    name: string;
    spanId: string;
    parentSpanId?: string;
    status?: { code: number };
    attributes: {
      key: string;
      value: {
        stringValue?: string;
        intValue?: string;
        boolValue?: boolean;
        doubleValue?: number;
      };
    }[];
  };
  const spans: Span[] = result.payloads.flatMap(
    (payload: { resourceSpans: { scopeSpans: { spans: Span[] }[] }[] }) =>
      payload.resourceSpans.flatMap((resource) =>
        resource.scopeSpans.flatMap((scope) => scope.spans),
      ),
  );
  const attrs = (span: Span | undefined) =>
    Object.fromEntries(
      (span?.attributes ?? []).map((attr) => [
        attr.key,
        attr.value.stringValue ??
          attr.value.intValue ??
          attr.value.boolValue ??
          attr.value.doubleValue,
      ]),
    );
  const evaluator = spans.find((span) => span.name === "orq.evaluation");
  expect(spans.filter((span) => span.name === "orq.evaluation")).toHaveLength(
    1,
  );
  expect(attrs(evaluator)).toMatchObject({
    "custom.verdict": true,
    "orq.redteam.jury.inconclusive": true,
    "orq.redteam.jury.judges_configured": 0,
  });
  expect(JSON.parse(String(attrs(evaluator).metadata))).toMatchObject({
    jury: { judges_configured: 0, raw_agreement: null, inconclusive: true },
  });
  expect(attrs(spans.find((span) => span.name === "chat echo"))).toMatchObject({
    "orq.llm.purpose": "attacker",
    "orq.redteam.llm_purpose": "attacker",
  });
  expect(
    attrs(spans.find((span) => span.name === "chat explicit"))[
      "orq.llm.purpose"
    ],
  ).toBe("explicit");
  expect(spans.find((span) => span.name === "failed")?.status?.code).toBe(2);
  const parent = spans.find((span) => span.name === "agent echo");
  const children = spans.filter(
    (span) => span.name === "agents.responses echo",
  );
  expect(children).toHaveLength(2);
  expect(children.every((span) => span.parentSpanId === parent?.spanId)).toBe(
    true,
  );
  expect(attrs(parent)).not.toHaveProperty("gen_ai.usage.total_tokens");
  expect(attrs(parent)["gen_ai.input.messages"]).toContain("latest");
  expect(attrs(parent)["gen_ai.output.messages"]).toContain("Done");
  for (const span of children)
    expect(attrs(span)).toMatchObject({
      "orq.llm.purpose": "target",
      "gen_ai.usage.input_tokens": 3,
      "gen_ai.usage.output_tokens": 2,
    });
});
