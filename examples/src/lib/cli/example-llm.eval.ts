import Anthropic from "@anthropic-ai/sdk";
import { type DataPoint, evaluatorq, type Job } from "@orq/evaluatorq";

import { containsNameValidator } from "../evals.js";

const claude = new Anthropic();

const greet: Job = async (data: DataPoint) => {
  const output = await claude.messages.create({
    stream: false,
    max_tokens: 100,
    model: "claude-3-5-haiku-latest",
    messages: [
      { role: "user", content: `Hello My name is ${data.inputs.name}` },
    ],
  });

  return {
    name: "greet",
    output: output.content[0].type === "text" ? output.content[0].text : "",
  };
};

await evaluatorq("dataset-evaluation", {
  data: [
    { inputs: { name: "Alice" } },
    { inputs: { name: "Bob" } },
    Promise.resolve({ inputs: { name: "Márk" } }),
  ],
  jobs: [greet],
  evaluators: [containsNameValidator],
  parallelism: 2,
  print: true,
});
