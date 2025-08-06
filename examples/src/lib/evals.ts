import type { Evaluator } from "@orq/evaluatorq";

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

export const containsNameValidator: Evaluator = {
  name: "contains-name",
  scorer: async ({ data, output }) => {
    if (output === undefined || output === null) return false;
    return String(output).includes(String(data.inputs.name));
  },
};
