import type { Agent, ToolSet } from "ai";
import type { DataPoint, Job, Output } from "../../types.js";
import type { AgentJobOptions } from "./types.js";
import { convertToOpenResponses } from "./convert.js";

/**
 * Creates an evaluatorq Job from any AI SDK Agent.
 *
 * Supports:
 * - `Agent` (base interface)
 * - `ToolLoopAgent`
 * - `Experimental_Agent` (deprecated alias for ToolLoopAgent)
 *
 * The job will:
 * - Execute the agent with the prompt from data.inputs
 * - Convert the result to OpenResponses format (industry standard)
 * - Return the OpenResponses resource for backend integration
 *
 * @example
 * ```typescript
 * import { wrapAISdkAgent } from "@orq-ai/evaluatorq/ai-sdk";
 * import { ToolLoopAgent, tool } from "ai";
 *
 * const weatherAgent = new ToolLoopAgent({
 *   model: openai("gpt-4o"),
 *   tools: {
 *     weather: tool({
 *       description: "Get the weather in a location",
 *       inputSchema: z.object({ location: z.string() }),
 *       execute: async ({ location }) => ({ location, temperature: 72 }),
 *     }),
 *   },
 * });
 *
 * await evaluatorq("weather-agent-eval", {
 *   data: [
 *     { inputs: { prompt: "What is the weather in SF?" } },
 *   ],
 *   jobs: [wrapAISdkAgent(weatherAgent)],
 *   evaluators: [
 *     {
 *       name: "response-quality",
 *       scorer: async ({ output }) => {
 *         const result = output as unknown as ResponseResource;
 *         // Access the final message text
 *         const lastMessage = result.output.find(
 *           (item) => item.type === "message"
 *         );
 *         return {
 *           value: lastMessage ? 1 : 0,
 *           explanation: "Agent produced a response",
 *         };
 *       },
 *     },
 *   ],
 * });
 * ```
 */
export function wrapAISdkAgent<TOOLS extends ToolSet>(
	agent: Agent<never, TOOLS, never>,
	options: AgentJobOptions = {},
): Job {
	const { name = agent.id ?? "agent", promptKey = "prompt" } = options;

	return async (data: DataPoint, _row: number) => {
		const prompt = data.inputs[promptKey];

		if (typeof prompt !== "string") {
			throw new Error(
				`Expected data.inputs.${promptKey} to be a string, got ${typeof prompt}`,
			);
		}

		const result = await agent.generate({ prompt });

		// Convert to OpenResponses format
		const openResponsesOutput = convertToOpenResponses(result, agent, prompt);

		return {
			name,
			output: openResponsesOutput as unknown as Output,
		};
	};
}
