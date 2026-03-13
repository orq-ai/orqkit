import type { OrqAgentInvokeRequest, OrqAgentMessage } from "./types";

export function buildA2AMessage(text: string): OrqAgentMessage {
	return {
		role: "user",
		parts: [{ kind: "text", text: text.trim() }],
	};
}

export function buildInvokeRequestBody(text: string): OrqAgentInvokeRequest {
	return {
		message: buildA2AMessage(text),
	};
}

export const MessageBuilder = {
	buildA2AMessage,
	buildInvokeRequestBody,
};
