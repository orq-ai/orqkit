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
              const taskId = `task-${++tasks}`;
              return (async function* () {
                // The shape of a real stream: only this first event holds the id.
                yield {
                  data: {
                    type: "agents.execution_started",
                    data: { agentTaskId: taskId },
                  },
                };
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

const { continueTurn, finishTurn, makeFakeClient } = await import(
  "../integrations/simulation/fake-client.js"
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

// Every conversation runs two turns, so the second call of each should continue.
const { client } = makeFakeClient({
  judge: (call: number) => (call % 2 === 0 ? continueTurn([]) : finishTurn([])),
});

if (process.argv[2] === "wrap") {
  const job = wrapSimulationAgent({ agentKey: "agent", client, maxTurns: 2 });
  for (const row of [0, 1]) {
    await job({ inputs: { datapoint } } as never, row);
  }
} else {
  await simulate({
    evaluationName: "agent-key",
    agentKey: "agent",
    client,
    maxTurns: 2,
    parallelism: 1,
    uploadResults: false,
    datapoints: [datapoint, datapoint],
  } as never);
}

console.log(JSON.stringify(calls));
