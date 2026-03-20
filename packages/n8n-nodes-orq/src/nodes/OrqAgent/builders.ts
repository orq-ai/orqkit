import type {
  InvokeAgentA2AMessage,
  InvokeAgentRequestBody,
} from "@orq-ai/node/models/operations";

export function buildA2AMessage(text: string): InvokeAgentA2AMessage {
  return {
    role: "user",
    parts: [{ kind: "text", text: text.trim() }],
  };
}

export function buildInvokeRequestBody(text: string): InvokeAgentRequestBody {
  return {
    message: buildA2AMessage(text),
  };
}
