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

const failingJob = job("failingJob", async () => {
  throw new Error("This is a failing job");
});

console.log("Testing sendResults functionality:");
console.log("ORQ_API_KEY is set:", Boolean(process.env.ORQ_API_KEY));

// Test 1: With sendResults explicitly set to true
console.log("\n=== Test 1: sendResults=true ===");
const results1 = await evaluatorq("test-send-results-explicit-true", {
  data: [{ inputs: { name: "Alice" } }, { inputs: { name: "Bob" } }],
  jobs: [greet, joker, failingJob],
  evaluators: [
    containsNameValidator,
    isItPoliteLLMEval,
    minLengthValidator(50),
  ],
  parallelism: 2,
  print: true,
  sendResults: true, // Explicitly enable sending results
  description: "Test evaluation with explicit sendResults=true",
});

console.log("\n=== Summary ===");
console.log("Test 1 - Results count:", results1.length);
