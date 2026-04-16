import type { CreateResponseBody, VariableValue } from "./types";

export interface VariableInput {
  name?: string;
  value?: string;
  isSecret?: boolean;
}

export interface BuildCreateResponseBodyArgs {
  agentKey: string;
  input: string;
  previousResponseId?: string;
  conversationId?: string;
  variables?: VariableInput[];
}

export function toVariablesMap(
  rows: VariableInput[] | undefined,
): Record<string, VariableValue> | undefined {
  if (!rows || rows.length === 0) return undefined;
  const map: Record<string, VariableValue> = {};
  for (const row of rows) {
    const name = row.name?.trim();
    if (!name) continue;
    const value = row.value ?? "";
    map[name] = row.isSecret ? { secret: true, value } : value;
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

export function buildCreateResponseBody({
  agentKey,
  input,
  previousResponseId,
  conversationId,
  variables,
}: BuildCreateResponseBodyArgs): CreateResponseBody {
  const body: CreateResponseBody = {
    model: `agent/${agentKey.trim()}`,
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

  const variablesMap = toVariablesMap(variables);
  if (variablesMap) {
    body.variables = variablesMap;
  }

  return body;
}
