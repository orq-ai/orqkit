import type { FunctionTool, ResponseResource } from "../../../generated/openresponses/index.js";

/**
 * Type definition for step data extracted from AI SDK results.
 */
export interface StepData {
	// Content array contains tool-call and tool-result items
	content?: Array<{
		type: string;
		toolCallId?: string;
		toolName?: string;
		input?: unknown;
		output?: unknown;
	}>;
	// Alternative: some AI SDK versions use toolCalls/toolResults arrays
	toolCalls?: Array<{
		toolCallId: string;
		toolName: string;
		args: unknown;
	}>;
	toolResults?: Array<{
		toolCallId: string;
		toolName: string;
		result: unknown;
	}>;
	request?: {
		body?: {
			input?: unknown[];
			tools?: FunctionTool[];
		};
	};
	response?: {
		body?: ResponseResource;
		messages?: Array<{
			role: string;
			content: Array<{
				type: string;
				toolCallId?: string;
				toolName?: string;
				input?: unknown;
				text?: string;
				providerOptions?: {
					openai?: {
						itemId?: string;
					};
				};
			}>;
		}>;
	};
	providerMetadata?: {
		openai?: {
			itemId?: string;
		};
	};
}

/**
 * Options for creating an evaluatorq Job from an AI SDK Agent.
 */
export interface AgentJobOptions {
	/** The name of the job (defaults to agent.id or "agent") */
	name?: string;
	/** The key in data.inputs to use as the prompt (defaults to "prompt") */
	promptKey?: string;
}
