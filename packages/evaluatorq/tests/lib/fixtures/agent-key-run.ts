const mode = process.argv[2];
const calls: { taskId?: string; serverURL: string }[] = [];
let tasks = 0;

Bun.plugin({
  name: "fake-orq-sdk",
  setup(build) {
    build.module("@orq-ai/node", () => ({
      loader: "object",
      exports: {
        Orq: class {
          constructor(private options: { serverURL: string }) {}
          agents = {
            stream: async (request: { taskId?: string }) => {
              calls.push({
                taskId: request.taskId,
                serverURL: this.options.serverURL,
              });
              const taskId = request.taskId ?? `task-${++tasks}`;
              const emitsId =
                !mode?.startsWith("no-task-id") &&
                !(mode === "resume-without-id" && request.taskId);
              return (async function* () {
                // Lets conversations overlap when rows run in parallel.
                await Bun.sleep(5);
                // The shape of a real stream: only this first event holds the id.
                if (emitsId) {
                  yield {
                    data: {
                      type: "agents.execution_started",
                      data: { agentTaskId: taskId },
                    },
                  };
                }
                yield {
                  data: {
                    type: "event.agents.inactive",
                    data: { lastMessage: "reply" },
                  },
                };
              })();
            },
          };
        },
      },
    }));
  },
});

const { continueTurn, makeFakeClient } = await import(
  "../integrations/simulation/fake-client.js"
);
const { fromOrqAgent } = await import(
  "../../../src/lib/integrations/simulation/adapters.js"
);
const { simulate } = await import(
  "../../../src/lib/integrations/simulation/simulation/index.js"
);
const { wrapSimulationAgent } = await import(
  "../../../src/lib/integrations/simulation/wrap-agent.js"
);

const persona = {
  name: "User",
  patience: 0.5,
  assertiveness: 0.5,
  politeness: 0.5,
  technical_level: 0.5,
  communication_style: "casual",
  background: "bg",
};
const scenario = { name: "Refund", goal: "Get a refund", criteria: [] };
const datapoint = {
  id: "dp",
  persona,
  scenario,
  user_system_prompt: "You are a simulated user.",
  first_message: "same opener",
};

// Every conversation runs to maxTurns, so each call after the first should continue.
const { client } = makeFakeClient({ judge: () => continueTurn([]) });

const base = {
  evaluationName: "agent-key",
  client,
  maxTurns: 2,
  parallelism: 1,
  uploadResults: false,
  datapoints: [datapoint, datapoint],
};

// Holds each row after its reply is stored, so both ids are in before any second turn.
const sharedAgent = fromOrqAgent("agent");
const overlapping = async (...args: Parameters<typeof sharedAgent>) => {
  const reply = await sharedAgent(...args);
  await Bun.sleep(20);
  return reply;
};

let reasons: string[] = [];
if (mode === "wrap") {
  const job = wrapSimulationAgent({ agentKey: "agent", client, maxTurns: 2 });
  for (const row of [0, 1]) {
    await job({ inputs: { datapoint } } as never, row);
  }
} else if (mode === "direct-callers") {
  const opener = { role: "user" as const, content: "same opener" };
  await sharedAgent([opener]);
  await sharedAgent([
    opener,
    { role: "assistant" as const, content: "reply" },
    { role: "user" as const, content: "next" },
  ]);
  await sharedAgent([opener]);
} else {
  const params = {
    simulate: { ...base, agentKey: "agent" },
    "shared-callback": { ...base, targetCallback: sharedAgent },
    parallel: { ...base, targetCallback: overlapping, parallelism: 2 },
    "resume-without-id": {
      ...base,
      agentKey: "agent",
      maxTurns: 3,
      datapoints: [datapoint],
    },
    "no-task-id": { ...base, agentKey: "agent", datapoints: [datapoint] },
    "no-task-id-one-turn": {
      ...base,
      agentKey: "agent",
      maxTurns: 1,
      datapoints: [datapoint],
    },
  }[mode as string];
  const results = await simulate(params as never);
  reasons = results.map((result: { reason?: string }) => result.reason ?? "");
}

console.log(JSON.stringify({ calls, reasons }));
