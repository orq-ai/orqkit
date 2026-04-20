import type { INode } from "n8n-workflow";
import { NodeOperationError } from "n8n-workflow";

import type {
  Content1,
  CreateResponseContentRouterResponses2,
  Output,
  Output1,
} from "@orq-ai/node/models/operations";

import { ERROR_MESSAGES } from "./constants";
import type { OrqCredentials } from "./types";

export function validateAgentKey(agentKey: string, node: INode): void {
  if (!agentKey || agentKey.trim() === "") {
    throw new NodeOperationError(node, ERROR_MESSAGES.AGENT_KEY_REQUIRED);
  }
}

export function validateMessage(message: string, node: INode): void {
  if (!message || message.trim() === "") {
    throw new NodeOperationError(node, ERROR_MESSAGES.MESSAGE_REQUIRED);
  }
}

export function validateCredentials(credentials: unknown, node: INode): void {
  if (!credentials) {
    throw new NodeOperationError(node, ERROR_MESSAGES.NO_CREDENTIALS);
  }

  const creds = credentials as OrqCredentials;
  if (!creds.apiKey) {
    throw new NodeOperationError(node, ERROR_MESSAGES.API_KEY_REQUIRED);
  }
}

export function validateThreadingExclusivity(
  previousResponseId: string | undefined,
  conversationId: string | undefined,
  node: INode,
): void {
  const hasPrev = !!previousResponseId && previousResponseId.trim() !== "";
  const hasConv = !!conversationId && conversationId.trim() !== "";
  if (hasPrev && hasConv) {
    throw new NodeOperationError(
      node,
      ERROR_MESSAGES.CONVERSATION_AND_PREVIOUS_RESPONSE_EXCLUSIVE,
    );
  }
}

export function isOutputMessage(item: Output): item is Output1 {
  return item.type === "message";
}

export function isOutputTextContent(
  content: Content1 | CreateResponseContentRouterResponses2,
): content is Content1 {
  return content.type === "output_text";
}

export function isRefusalContent(
  content: Content1 | CreateResponseContentRouterResponses2,
): content is CreateResponseContentRouterResponses2 {
  return content.type === "refusal";
}

export const Validators = {
  validateAgentKey,
  validateMessage,
  validateCredentials,
  validateThreadingExclusivity,
};
