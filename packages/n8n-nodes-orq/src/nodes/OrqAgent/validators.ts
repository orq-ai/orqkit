import type { INode } from "n8n-workflow";
import { NodeOperationError } from "n8n-workflow";

import { ERROR_MESSAGES } from "./constants";
import type {
  OrqCredentials,
  ResponseOutputContent,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseOutputRefusalContent,
  ResponseOutputTextContent,
} from "./types";

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

export function isOutputMessage(
  item: ResponseOutputItem,
): item is ResponseOutputMessage {
  return (
    item.type === "message" &&
    Array.isArray((item as ResponseOutputMessage).content)
  );
}

export function isOutputTextContent(
  content: ResponseOutputContent,
): content is ResponseOutputTextContent {
  return (
    content.type === "output_text" &&
    typeof (content as ResponseOutputTextContent).text === "string"
  );
}

export function isRefusalContent(
  content: ResponseOutputContent,
): content is ResponseOutputRefusalContent {
  return (
    content.type === "refusal" &&
    typeof (content as ResponseOutputRefusalContent).refusal === "string"
  );
}

export const Validators = {
  validateAgentKey,
  validateMessage,
  validateCredentials,
  validateThreadingExclusivity,
};
