import type { INode } from "n8n-workflow";
import { NodeOperationError } from "n8n-workflow";

import type { TextPart } from "@orq-ai/node/models/components";
import type { Parts } from "@orq-ai/node/models/operations";

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
    throw new NodeOperationError(node, "API Key is required in credentials");
  }
}

export function isTextPart(part: Parts): part is TextPart {
  return part.kind === "text";
}

export const Validators = {
  validateAgentKey,
  validateMessage,
  validateCredentials,
};
