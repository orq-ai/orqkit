import { z } from "zod";

/**
 * Message schema for AI conversations (role + content pairs)
 */
export const MessageSchema = z.object({
	role: z.enum(["system", "user", "assistant"]).describe("The role of the message sender"),
	content: z.string().describe("The content of the message"),
});

export type Message = z.infer<typeof MessageSchema>;

/**
 * Array of messages for conversations
 */
export const MessagesArraySchema = z.array(MessageSchema);

/**
 * Common pagination parameters
 */
export const PaginationSchema = z.object({
	limit: z.number().optional().describe("Maximum number of items to return"),
	cursor: z.string().optional().describe("Cursor for pagination"),
});

/**
 * Prompt creation/update parameters
 */
export const PromptConfigSchema = z.object({
	model: z.string().describe("The model to use (e.g., 'gpt-4', 'claude-3-sonnet')"),
	messages: MessagesArraySchema.describe("Array of messages defining the prompt"),
	temperature: z.number().min(0).max(2).optional().describe("Sampling temperature (0-2)"),
	maxTokens: z.number().int().min(1).optional().describe("Maximum tokens in the response"),
});

export type PromptConfig = z.infer<typeof PromptConfigSchema>;
