import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

import {
  executeFind,
  type FindCommandArguments,
} from "@orq-ai/evaluatorq/trace-finder";

export async function find(
  query: string,
  options: Omit<FindCommandArguments, "query">,
): Promise<void> {
  try {
    const code = await executeFind(
      {
        ...options,
        jsonPath: (
          options as Omit<FindCommandArguments, "query"> & { json?: string }
        ).json,
        query,
      },
      {
        print: (message) => console.log(message),
        interactive: Boolean(stdin.isTTY && stdout.isTTY),
        confirm: async (_rows, snapshot) => {
          const reader = createInterface({ input: stdin, output: stdout });
          try {
            const reply = await reader.question(
              `Classify ${snapshot.total} ${snapshot.total === 1 ? "trace" : "traces"}? [y/N] `,
            );
            return /^(?:y|yes)$/i.test(reply.trim());
          } finally {
            reader.close();
          }
        },
      },
    );
    if (code) process.exitCode = code;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
