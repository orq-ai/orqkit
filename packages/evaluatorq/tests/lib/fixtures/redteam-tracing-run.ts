import type { Orq } from "@orq-ai/node";

import { JuryResultSchema, MessageSchema } from "../../../src/lib/contracts.js";
import {
  annotateCurrentSpan,
  OrqAgentTarget,
  setJurySpanAttrs,
  withRedteamLlmSpan,
  withRedteamSpan,
} from "../../../src/lib/redteam/index.js";
import {
  flushTracing,
  initTracingIfNeeded,
  shutdownTracing,
} from "../../../src/lib/tracing/setup.js";

const payloads: unknown[] = [];
const collector = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.method === "GET") return Response.json({ data: [] });
    payloads.push(await request.json());
    return Response.json({});
  },
});
process.env.ORQ_BASE_URL = collector.url.toString();
process.env.OTEL_EXPORTER_OTLP_ENDPOINT = collector.url.toString();
delete process.env.ORQ_DISABLE_TRACING;
delete process.env.ORQ_API_KEY;
process.env.EVALUATORQ_CAPTURE_MESSAGE_CONTENT = "true";
try {
  if (!(await initTracingIfNeeded())) throw new Error("Tracing unavailable");
  let calls = 0;
  const client = {
    agents: {
      responses: {
        create: async () => ({
          taskId: "task",
          model: "echo",
          output:
            calls++ === 0 ? [] : [{ parts: [{ kind: "text", text: "Done" }] }],
          pendingToolCalls:
            calls === 1
              ? [{ id: "call", function: { name: "lookup", arguments: "{}" } }]
              : [],
          usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
        }),
      },
    },
  } as unknown as Orq;
  await withRedteamSpan("attack", {}, async () => {
    await withRedteamSpan("orq.evaluation", {}, async () =>
      annotateCurrentSpan({ "custom.verdict": true }, async (span) => {
        setJurySpanAttrs(
          span,
          JuryResultSchema.parse({
            judgesConfigured: 0,
            judgesSucceeded: 0,
            judgesFailed: 0,
            inconclusive: true,
          }),
        );
      }),
    );
    await withRedteamLlmSpan(
      { model: "echo", attributes: { "orq.redteam.llm_purpose": "attacker" } },
      async () => {},
    );
    await withRedteamLlmSpan(
      {
        model: "explicit",
        attributes: {
          "orq.redteam.llm_purpose": "attacker",
          "orq.llm.purpose": "explicit",
        },
      },
      async () => {},
    );
    try {
      await withRedteamSpan("failed", {}, async () => {
        throw new TypeError("Synthetic failure");
      });
    } catch {}
    await new OrqAgentTarget("echo", client).respond([
      MessageSchema.parse({ role: "user", content: "latest" }),
    ]);
  });
  await flushTracing();
  console.log(JSON.stringify({ payloads }));
} finally {
  await shutdownTracing();
  collector.stop(true);
}
