import type { CreateResponseBody } from "./types";

export interface BuildCreateResponseBodyArgs {
  agentKey: string;
  input: string;
  previousResponseId?: string;
  conversationId?: string;
}

export function buildCreateResponseBody({
  agentKey,
  input,
  previousResponseId,
  conversationId,
}: BuildCreateResponseBodyArgs): CreateResponseBody {
  const body: CreateResponseBody = {
    model: `agent/${agentKey}`,
    input: input.trim(),
    stream: false,
  };

  const trimmedPrev = previousResponseId?.trim();
  if (trimmedPrev) {
    body.previous_response_id = trimmedPrev;
  }

  const trimmedConv = conversationId?.trim();
  if (trimmedConv) {
    body.conversation = { id: trimmedConv };
  }

  return body;
}
