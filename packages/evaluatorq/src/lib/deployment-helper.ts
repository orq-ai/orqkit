import type { Orq } from "@orq-ai/node";

/**
 * Options for invoking a deployment.
 */
export interface DeploymentOptions {
  /** Input variables for the deployment template */
  inputs?: Record<string, unknown>;
  /** Context attributes for routing */
  context?: Record<string, unknown>;
  /** Metadata to attach to the request */
  metadata?: Record<string, unknown>;
  /** Thread configuration for conversation tracking. ID is required if thread is provided. */
  thread?: {
    id: string;
    tags?: string[];
  };
  /** Chat messages for conversational deployments */
  messages?: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }>;
}

/**
 * Response from a deployment invocation.
 */
export interface DeploymentResponse {
  /** The text content of the response */
  content: string;
  /** The raw response from the API */
  raw: unknown;
}

// Cached client instance
let cachedClient: Orq | undefined;

/**
 * Get or create an Orq client instance.
 * Reuses the same client for the entire process.
 */
async function getOrCreateClient(): Promise<Orq> {
  if (cachedClient) {
    return cachedClient;
  }

  const apiKey = process.env.ORQ_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ORQ_API_KEY environment variable must be set to use the deployment helper.",
    );
  }

  try {
    const client = await import("@orq-ai/node");
    const serverURL = process.env.ORQ_BASE_URL || "https://my.orq.ai";

    cachedClient = new client.Orq({ apiKey, serverURL });
    return cachedClient;
  } catch (error: unknown) {
    const err = error as Error & { code?: string };
    if (
      err.code === "MODULE_NOT_FOUND" ||
      err.code === "ERR_MODULE_NOT_FOUND" ||
      err.message?.includes("Cannot find module")
    ) {
      throw new Error(
        "The @orq-ai/node package is not installed. To use deployment features, please install it:\n" +
          "  npm install @orq-ai/node\n" +
          "  # or\n" +
          "  yarn add @orq-ai/node\n" +
          "  # or\n" +
          "  bun add @orq-ai/node",
      );
    }
    throw new Error(`Failed to setup ORQ client: ${err.message || err}`);
  }
}

/**
 * Invoke an Orq deployment and return the response content.
 *
 * @param key - The deployment key (name)
 * @param options - Optional parameters for the invocation
 * @returns The deployment response with content and raw response
 *
 * @example
 * // Simple invocation
 * const response = await deployment("my-deployment");
 * console.log(response.content);
 *
 * @example
 * // With inputs
 * const response = await deployment("summarizer", {
 *   inputs: { text: "Long text to summarize..." }
 * });
 *
 * @example
 * // With messages for chat-style deployments
 * const response = await deployment("chatbot", {
 *   messages: [
 *     { role: "user", content: "Hello!" }
 *   ]
 * });
 *
 * @example
 * // With thread tracking
 * const response = await deployment("assistant", {
 *   inputs: { query: "What is AI?" },
 *   thread: { id: "conversation-123" }
 * });
 */
export async function deployment(
  key: string,
  options: DeploymentOptions = {},
): Promise<DeploymentResponse> {
  const client = await getOrCreateClient();

  const completion = await client.deployments.invoke({
    key,
    inputs: options.inputs,
    context: options.context,
    metadata: options.metadata,
    thread: options.thread,
    messages: options.messages,
  });

  // Extract content from the response
  let content = "";
  const firstChoice = completion?.choices?.[0];

  if (firstChoice?.message) {
    const message = firstChoice.message;
    if (message.type === "content" && typeof message.content === "string") {
      content = message.content;
    } else if (message.type === "content" && Array.isArray(message.content)) {
      // Handle array content (e.g., multimodal responses)
      content = message.content
        .filter(
          (
            part,
          ): part is {
            type: "text";
            text: string;
          } => part.type === "text",
        )
        .map((part) => part.text)
        .join("\n");
    }
  }

  return {
    content,
    raw: completion,
  };
}

/**
 * Invoke an Orq deployment and return just the text content.
 * This is a convenience wrapper around `deployment()` for simple use cases.
 *
 * @param key - The deployment key (name)
 * @param options - Optional parameters for the invocation
 * @returns The text content of the response
 *
 * @example
 * // In a job
 * const myJob = job("my-job", async (data) => {
 *   return await invoke("summarizer", { inputs: data.inputs });
 * });
 */
export async function invoke(
  key: string,
  options: DeploymentOptions = {},
): Promise<string> {
  const response = await deployment(key, options);
  return response.content;
}
