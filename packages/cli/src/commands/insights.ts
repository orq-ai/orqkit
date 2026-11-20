import {
  executeInsights,
  type InsightsCommandArguments,
} from "@orq-ai/evaluatorq/insights";

export async function runInsights(
  options: InsightsCommandArguments,
): Promise<void> {
  try {
    const code = await executeInsights(options, {
      print: (message) => console.log(message),
    });
    if (code) process.exitCode = code;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
