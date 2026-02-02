/**
 * Shared utilities for agent integrations.
 */

import type { DataPoint } from "../../types.js";
import type { ResponseResource } from "../openresponses/index.js";

/**
 * Generates a unique ID for OpenResponses items.
 *
 * @param prefix - The prefix for the ID (e.g., "fc" for function_call, "msg" for message)
 * @returns A unique string ID with the given prefix
 */
export function generateItemId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

/**
 * Serializes tool arguments to a JSON string.
 *
 * @param args - The arguments to serialize (can be any type)
 * @returns A JSON string representation of the arguments
 */
export function serializeArgs(args: unknown): string {
  if (typeof args === "string") {
    return args;
  }
  return JSON.stringify(args);
}

/**
 * Maps a finish reason to an OpenResponses status.
 * Handles common finish reasons from various providers.
 *
 * @param finishReason - The finish reason from the LLM response
 * @returns The corresponding OpenResponses status
 */
export function getResponseStatus(
  finishReason: string | undefined,
): ResponseResource["status"] {
  switch (finishReason) {
    case "stop":
    case "tool-calls":
      return "completed";
    case "error":
      return "failed";
    case "length":
    case "content-filter":
      return "incomplete";
    default:
      return "completed";
  }
}

/**
 * Extracts and validates a prompt string from a DataPoint.
 *
 * @param data - The data point containing inputs
 * @param promptKey - The key to look up in data.inputs
 * @returns The prompt string
 * @throws Error if the prompt is not a string
 */
export function extractPromptFromData(
  data: DataPoint,
  promptKey: string,
): string {
  const prompt = data.inputs[promptKey];
  if (typeof prompt !== "string") {
    throw new Error(
      `Expected data.inputs.${promptKey} to be a string, got ${typeof prompt}`,
    );
  }
  return prompt;
}
