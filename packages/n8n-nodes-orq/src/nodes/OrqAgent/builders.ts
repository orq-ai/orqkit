import type { CreateResponseBody } from "./types";

export interface BuildCreateResponseBodyArgs {
  agentKey: string;
  input: string;
}

export function buildCreateResponseBody({
  agentKey,
  input,
}: BuildCreateResponseBodyArgs): CreateResponseBody {
  return {
    model: `agent/${agentKey.trim()}`,
    input: input.trim(),
    stream: false,
  };
}
