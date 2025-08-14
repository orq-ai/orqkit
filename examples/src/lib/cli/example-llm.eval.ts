import Anthropic from "@anthropic-ai/sdk";

import { type DataPoint, evaluatorq, job } from "@orq-ai/evaluatorq";

import { containsNameValidator, isItPoliteLLMEval } from "../evals.js";

const claude = new Anthropic();

const greet = job("greet", async (data: DataPoint) => {
  const output = await claude.messages.create({
    stream: false,
    max_tokens: 100,
    model: "claude-3-5-haiku-latest",
    system: `For testing purposes please be really lazy and sarcastic in your response, not polite at all.`,
    messages: [
      {
        role: "user",
        content: `Hello My name is ${data.inputs.name}`,
      },
    ],
  });

  return output.content[0].type === "text" ? output.content[0].text : "";
});

await evaluatorq("dataset-evaluation", {
  data: [
    { inputs: { name: "Alice" } },
    { inputs: { name: "Bob" } },
    Promise.resolve({ inputs: { name: "Márk" } }),
  ],
  jobs: [greet],
  evaluators: [containsNameValidator, isItPoliteLLMEval],
  parallelism: 2,
  print: true,
});
