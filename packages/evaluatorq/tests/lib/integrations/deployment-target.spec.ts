import { expect, it } from "bun:test";

it("retains real SDK deployment usage, pipeline/thread metadata and saved labels", async () => {
  const process = Bun.spawn(
    [
      "bun",
      new URL("../fixtures/deployment-target-run.ts", import.meta.url).pathname,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [output, errors, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (code) throw new Error(errors + output);
  const result = JSON.parse(output.trim().split("\n").at(-1) ?? "{}");
  expect(result).toMatchObject({
    text: "mango",
    usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5, calls: 1 },
    callbackKey: "echo",
    noUsage: null,
    simulationUsage: { totalTokens: 10 },
    savedTarget: "deployment:echo",
    savedKind: "orq_deployment",
    request: {
      key: "echo",
      metadata: { evaluatorq_pipeline: "simulation", evaluatorq_run_id: "run" },
      thread: { id: "thread" },
      messages: [{ role: "user", content: "Reply mango" }],
    },
  });
  expect(result.lastRequest.thread.id).toBeString();
  expect(result.lastRequest.metadata.evaluatorq_run_id).toBeString();
});
