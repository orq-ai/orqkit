import {
  executeSessions,
  type SessionArguments,
} from "@orq-ai/evaluatorq/local-sessions";
import { BadParameter } from "@orq-ai/evaluatorq/redteam";

export async function runSessions(options: SessionArguments): Promise<void> {
  try {
    const code = await executeSessions(options, {
      print: (message) => console.log(message),
      warn: (message) => console.error(message),
    });
    if (code) process.exitCode = code;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof BadParameter ? 2 : 1;
  }
}
