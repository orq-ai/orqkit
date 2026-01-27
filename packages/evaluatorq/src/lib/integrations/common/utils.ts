/**
 * Shared utilities for agent integrations.
 */

/**
 * Generates a unique ID for OpenResponses items.
 *
 * @param prefix - The prefix for the ID (e.g., "fc" for function_call, "msg" for message)
 * @returns A unique string ID with the given prefix
 */
export function generateItemId(prefix: string): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `${prefix}_${timestamp}${random}`;
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
