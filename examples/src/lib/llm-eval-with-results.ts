import Anthropic from "@anthropic-ai/sdk";

import { type DataPoint, evaluatorq, job } from "@orq-ai/evaluatorq";

import {
  containsNameValidator,
  isItPoliteLLMEval,
  minLengthValidator,
} from "./evals.js";

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

const joker = job("joker", async (data: DataPoint) => {
  const output = await claude.messages.create({
    stream: false,
    max_tokens: 100,
    model: "claude-3-5-haiku-latest",
    system: `You are a joker. You are funny and sarcastic. You are also a bit of a smartass. and make fun of the name of the user`,
    messages: [
      {
        role: "user",
        content: `Hello My name is ${data.inputs.name}`,
      },
    ],
  });

  return output.content[0].type === "text" ? output.content[0].text : "";
});

const calculator = job("calculator", async (data: DataPoint) => {
  const output = await claude.messages.create({
    stream: false,
    max_tokens: 100,
    model: "claude-3-5-haiku-latest",
    system: `You are a mathematician. You bring up a relating theory or a recent discovery when somebody talks to you.`,
    messages: [
      {
        role: "user",
        content: `Hello My name is ${data.inputs.name}`,
      },
    ],
  });

  return output.content[0].type === "text" ? output.content[0].text : "";
});

const results = await evaluatorq("dataset-evaluation", {
  data: [
    { inputs: { name: "Alice" } },
    { inputs: { name: "Bob" } },
    Promise.resolve({ inputs: { name: "Márk" } }),
  ],
  jobs: [greet, joker, calculator],
  evaluators: [
    containsNameValidator,
    isItPoliteLLMEval,
    minLengthValidator(70),
  ],
  parallelism: 2,
  print: true,
});

console.log(JSON.stringify(results, null, 2));
