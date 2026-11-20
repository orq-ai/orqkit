import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  conversationThread,
  evaluatorqPipeline,
  evaluatorqRunId,
} from "../../../src/lib/common/thread-context.js";
import { deployment } from "../../../src/lib/deployment-helper.js";
import {
  fromOrqDeployment,
  SimulationRun,
  simulate,
} from "../../../src/lib/integrations/simulation/index.js";
import { parseSavedDatapoint } from "../../../src/lib/integrations/simulation/run-store.js";
import { makeFakeClient } from "../integrations/simulation/fake-client.js";
import fixture from "./simulation-run-python-goldens.json" with {
  type: "json",
};

const requests: Record<string, unknown>[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.method === "GET") return Response.json({ data: [] });
    const body = (await request.json()) as Record<string, unknown>;
    requests.push(body);
    return Response.json({
      id: "reply",
      created: "2026-11-09T12:30:00Z",
      object: "chat",
      model: "echo",
      provider: "openai",
      is_final: true,
      telemetry: { trace_id: "trace", span_id: "span" },
      choices: [
        {
          index: 0,
          message: { type: "content", role: "assistant", content: "mango" },
        },
      ],
      ...(body.key === "no-usage"
        ? {}
        : {
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          }),
    });
  },
});
process.env.ORQ_API_KEY = "synthetic-key";
process.env.ORQ_BASE_URL = `http://127.0.0.1:${server.port}`;
process.env.ORQ_DISABLE_TRACING = "1";
const dir = await mkdtemp(join(tmpdir(), "res1863-deployment-"));
process.env.EVALUATORQ_DIR = dir;
try {
  const callback = fromOrqDeployment("echo");
  const response = await evaluatorqPipeline("simulation", () =>
    evaluatorqRunId("run", () =>
      conversationThread("thread", () =>
        callback([{ role: "user", content: "Reply mango" }]),
      ),
    ),
  );
  const noUsage = await deployment("no-usage", {
    messages: [{ role: "user", content: "hi" }],
  });
  const path = join(dir, "run.json");
  const results = await simulate({
    target: callback,
    client: makeFakeClient().client,
    datapoints: [parseSavedDatapoint(fixture.run.datapoints?.[0])],
    maxTurns: 1,
    uploadResults: false,
    recommendations: false,
    executiveSummary: false,
    save: true,
    reportPath: path,
  });
  const saved = await SimulationRun.load(path);
  console.log(
    JSON.stringify({
      text: response.text,
      usage: response.usage,
      callbackKey: callback.deploymentKey,
      request: requests[0],
      noUsage: noUsage.usage,
      simulationUsage: results[0]?.usage,
      savedTarget: saved.target,
      savedKind: saved.targetKind,
      lastRequest: requests.at(-1),
    }),
  );
} finally {
  server.stop(true);
  await rm(dir, { recursive: true, force: true });
}
