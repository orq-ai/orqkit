import Anthropic from "@anthropic-ai/sdk";

import {
  type DataPoint,
  type Evaluator,
  evaluatorq,
  job,
} from "@orq-ai/evaluatorq";
import { Orq } from "@orq-ai/node";

const claude = new Anthropic();

const orq = new Orq({
  apiKey: process.env.ORQ_API_KEY,
  serverURL: process.env.ORQ_BASE_URL || "https://my.orq.ai",
});

const ROUGE_N_EVALUATOR_ID = "<your-rouge-n-evaluator-id>";

const BERT_SCORE_EVALUATOR_ID = "<your-bert-score-evaluator-id>";

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

const lengthSimilarityEvaluator: Evaluator = {
  name: "length-similarity",
  scorer: async ({ data, output }) => {
    const expected = String(data.expectedOutput ?? "");
    const actual = String(output);
    const maxLen = Math.max(expected.length, actual.length, 1);
    const score = 1 - Math.abs(expected.length - actual.length) / maxLen;
    return {
      value: Math.round(score * 100) / 100,
      explanation: `Length similarity: expected ${expected.length} chars, got ${actual.length} chars`,
    };
  },
};

const rougeNEvaluator: Evaluator = {
  name: "rouge_n",
  scorer: async ({ data, output }) => {
    const result = await orq.evals.invoke({
      id: ROUGE_N_EVALUATOR_ID,
      requestBody: {
        output: String(output),
        reference: String(data.expectedOutput ?? ""),
      },
    });
    if (
      "value" in result &&
      typeof result.value === "object" &&
      result.value !== null
    ) {
      const val = result.value as {
        rouge1?: { f1: number };
        rouge2?: { f1: number };
        rougeL?: { f1: number };
      };
      return {
        value: {
          type: "rouge_n",
          value: {
            rouge_1: val.rouge1 ?? { precision: 0, recall: 0, f1: 0 },
            rouge_2: val.rouge2 ?? { precision: 0, recall: 0, f1: 0 },
            rouge_l: val.rougeL ?? { precision: 0, recall: 0, f1: 0 },
          },
        },
        explanation: "ROUGE-N similarity scores between output and reference",
      };
    }
    return { value: 0, explanation: "Unexpected response format" };
  },
};

const bertScoreEvaluator: Evaluator = {
  name: "bert-score",
  scorer: async ({ data, output }) => {
    const reference = String(data.expectedOutput ?? "");
    const result = await orq.evals.invoke({
      id: BERT_SCORE_EVALUATOR_ID,
      requestBody: {
        output: String(output),
        reference,
      },
    });

    if (
      "value" in result &&
      typeof result.value === "object" &&
      result.value !== null
    ) {
      const val = result.value as {
        precision: number;
        recall: number;
        f1: number;
      };
      return {
        value: {
          type: "bert_score",
          value: {
            precision: val.precision,
            recall: val.recall,
            f1: val.f1,
          },
        },
        explanation:
          "BERTScore semantic similarity between output and reference",
      };
    }
    return { value: 0, explanation: "Unexpected response format" };
  },
};

await evaluatorq("llm-eval-with-results", {
  data: [
    {
      inputs: { name: "Alice" },
      expectedOutput: "Hello Alice, nice to meet you!",
    },
    {
      inputs: { name: "Bob" },
      expectedOutput: "Hello Bob, nice to meet you!",
    },
    Promise.resolve({
      inputs: { name: "Márk" },
      expectedOutput: "Hello Márk, nice to meet you!",
    }),
  ],
  jobs: [greet, joker, calculator],
  evaluators: [lengthSimilarityEvaluator, bertScoreEvaluator, rougeNEvaluator],
  parallelism: 4,
  print: true,
});
