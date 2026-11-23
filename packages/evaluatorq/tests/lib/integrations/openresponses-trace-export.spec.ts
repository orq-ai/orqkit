import { expect, it } from "bun:test";

it("flushes real target request/tool spans to a local OTel collector before returning", async () => {
  const child = Bun.spawn(
    [
      "bun",
      new URL("../fixtures/openresponses-trace-run.ts", import.meta.url)
        .pathname,
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
  expect(result.isAgentResponse).toBe(true);
  const spans = result.payloads.flatMap(
    (payload: { resourceSpans: { scopeSpans: { spans: unknown[] }[] }[] }) =>
      payload.resourceSpans.flatMap((resource) =>
        resource.scopeSpans.flatMap((scope) => scope.spans),
      ),
  );
  expect(spans).toHaveLength(1);
  const attrs = Object.fromEntries(
    spans[0].attributes.map(
      (attribute: {
        key: string;
        value: { stringValue?: string; intValue?: number };
      }) => [
        attribute.key,
        attribute.value.stringValue ?? attribute.value.intValue,
      ],
    ),
  );
  expect(attrs["openresponses.instructions"]).toBe("Call lookup.");
  expect(attrs["orq.llm.purpose"]).toBe("target");
  expect(attrs["orq.simulation.llm_purpose"]).toBe("target");
  expect(
    JSON.parse(String(attrs["gen_ai.output.messages"]))[0].parts[0],
  ).toMatchObject({
    type: "tool_call",
    name: "lookup",
    arguments: { q: "hello" },
  });
  expect(JSON.parse(String(attrs["orq.openresponses.request"]))).toMatchObject({
    model: "test",
    reasoning: { effort: "low" },
    max_output_tokens: 4000,
  });
});
