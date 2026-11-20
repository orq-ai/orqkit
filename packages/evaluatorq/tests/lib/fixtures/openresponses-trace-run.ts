import type OpenAI from "openai";

import {
  AgentResponse,
  LLMCallConfig,
  MessageSchema,
} from "../../../src/lib/contracts.js";
import { OrqResponsesTarget } from "../../../src/lib/integrations/openresponses/target.js";
import {
  flushTracing,
  initTracingIfNeeded,
  shutdownTracing,
} from "../../../src/lib/tracing/setup.js";

const payloads: Record<string, unknown>[] = [];
const collector = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.method === "GET") return Response.json({ data: [] });
    payloads.push((await request.json()) as Record<string, unknown>);
    return Response.json({});
  },
});
process.env.ORQ_BASE_URL = `http://127.0.0.1:${collector.port}`;
process.env.OTEL_EXPORTER_OTLP_ENDPOINT = process.env.ORQ_BASE_URL;
delete process.env.ORQ_DISABLE_TRACING;
delete process.env.ORQ_API_KEY;
process.env.EVALUATORQ_CAPTURE_MESSAGE_CONTENT = "true";
const client = {
  responses: {
    create: async () => ({
      id: "reply",
      status: "completed",
      output: [
        {
          type: "function_call",
          call_id: "call",
          name: "lookup",
          arguments: '{"q":"hello"}',
        },
      ],
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    }),
  },
} as unknown as OpenAI;
const target = new OrqResponsesTarget(
  new LLMCallConfig({
    client,
    model: "test",
    reasoningEffort: "low",
    maxTokens: 4000,
  }),
  {
    client,
    requireOrq: false,
    instructions: "Call lookup.",
    tools: [
      {
        type: "function",
        name: "lookup",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    ],
  },
);
try {
  if (!(await initTracingIfNeeded()))
    throw new Error("Tracing did not initialize");
  const response = await target.respond([
    MessageSchema.parse({ role: "user", content: "Look up hello." }),
  ]);
  await flushTracing();
  console.log(
    JSON.stringify({
      isAgentResponse: response instanceof AgentResponse,
      payloads,
    }),
  );
} finally {
  await target.close();
  await shutdownTracing();
  collector.stop(true);
}
