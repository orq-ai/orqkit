import { coerceContentText } from "../../common/messages.js";
import type { RedTeamResult } from "./models.js";

export function extractPrompt(result: RedTeamResult): string {
  for (const message of result.messages)
    if (message.role === "user" && message.content)
      return coerceContentText(message.content);
  return "";
}
export function extractResponse(result: RedTeamResult): string {
  if (result.response) return result.response;
  for (const message of [...result.messages].reverse())
    if (message.role === "assistant" && message.content)
      return coerceContentText(message.content);
  return "";
}
