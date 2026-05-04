import Anthropic from "@anthropic-ai/sdk";

import type { Evaluator } from "@orq-ai/evaluatorq";

export function maxLengthValidator(max: number): Evaluator {
  return {
    name: `max-length-${max}`,
    scorer: async ({ output }) => {
      if (output === undefined || output === null) {
        return {
          value: false,
          explanation: "Output is null or undefined",
        };
      }
      const hasValidLength =
        (typeof output === "object" &&
          "length" in output &&
          Number(output.length) <= max) ??
        false;
      return {
        value: hasValidLength,
        explanation: hasValidLength
          ? `Length is within limit (≤${max})`
          : `Length exceeds limit of ${max}`,
      };
    },
  };
}

export function minLengthValidator(min: number): Evaluator {
  return {
    name: `min-length-${min}`,
    scorer: async ({ output }) => {
      if (output === undefined || output === null) {
        return {
          value: false,
          explanation: "Output is null or undefined",
        };
      }
      const meetsMinLength =
        (typeof output === "string" && output.length >= min) ?? false;
      return {
        value: meetsMinLength,
        explanation: meetsMinLength
          ? `String length meets minimum (≥${min})`
          : typeof output === "string"
            ? `String length ${output.length} is below minimum ${min}`
            : "Output is not a string",
      };
    },
  };
}

export const containsNameValidator: Evaluator = {
  name: "contains-name",
  scorer: async ({ data, output }) => {
    if (output === undefined || output === null) {
      return {
        value: false,
        explanation: "Output is null or undefined",
      };
    }
    const name = String(data.inputs.name);
    const containsName = String(output).includes(name);
    return {
      value: containsName,
      explanation: containsName
        ? `Output contains the name "${name}"`
        : `Output does not contain the name "${name}"`,
    };
  },
};

const claude = new Anthropic();

export const isItPoliteLLMEval: Evaluator = {
  name: "is-it-polite",
  scorer: async ({ output }) => {
    const response = await claude.messages.create({
      stream: false,
      max_tokens: 200,
      model: "claude-3-5-haiku-latest",
      messages: [
        {
          role: "user",
          content: `Evaluate how polite the following response is on a scale from 0 to 1, where 0 is extremely rude and 1 is extremely polite.

Response to evaluate: "${output}"

Return ONLY valid JSON in this format:
{"score": 0.85, "explanation": "Brief explanation of the score"}

The score must be a float between 0 and 1.`,
        },
      ],
    });

    try {
      const text =
        response.content[0].type === "text" ? response.content[0].text : "{}";
      const result = JSON.parse(text) as {
        score: number;
        explanation?: string;
      };
      return {
        value: result.score,
        explanation:
          result.explanation || `Politeness score: ${result.score.toFixed(2)}`,
      };
    } catch (error) {
      console.error("Failed to parse politeness score:", error);

      console.dir(response, { depth: null });
      return {
        value: 0,
        explanation:
          "Failed to evaluate politeness (LLM response parsing error)",
      };
    }
  },
};
