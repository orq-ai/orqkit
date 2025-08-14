import Anthropic from "@anthropic-ai/sdk";

import type { Evaluator } from "@orq-ai/evaluatorq";

export function maxLengthValidator(max: number): Evaluator {
  return {
    name: `max-length-${max}`,
    scorer: async ({ output }) => {
      if (output === undefined || output === null) return false;
      return (
        (typeof output === "object" &&
          "length" in output &&
          Number(output.length) <= max) ??
        false
      );
    },
  };
}

export function minLengthValidator(min: number): Evaluator {
  return {
    name: `min-length-${min}`,
    scorer: async ({ output }) => {
      if (output === undefined || output === null) return false;
      return (typeof output === "string" && output.length >= min) ?? false;
    },
  };
}

export const containsNameValidator: Evaluator = {
  name: "contains-name",
  scorer: async ({ data, output }) => {
    if (output === undefined || output === null) return false;
    return String(output).includes(String(data.inputs.name));
  },
};

const claude = new Anthropic();

export const isItPoliteLLMEval: Evaluator = {
  name: "is-it-polite",
  scorer: async ({ output }) => {
    const response = await claude.messages.create({
      stream: false,
      max_tokens: 100,
      model: "claude-3-5-haiku-latest",
      messages: [
        {
          role: "user",
          content: `Evaluate how polite the following response is on a scale from 0 to 1, where 0 is extremely rude and 1 is extremely polite.

Response to evaluate: "${output}"

Return ONLY valid JSON in this format:
{"score": 0.85}

The score must be a float between 0 and 1. NO EXPLANATION, NO COMMENTS, NO THINKING, NO NOTHING, ONLY JSON.`,
        },
      ],
    });

    try {
      const text =
        response.content[0].type === "text" ? response.content[0].text : "{}";
      const result = JSON.parse(text) as { score: number };
      return result.score;
    } catch (error) {
      console.error("Failed to parse politeness score:", error);

      console.dir(response, { depth: null });
      return 0; // Default to zero, since the evaluator is really impolite to return a non JSON response.
    }
  },
};
