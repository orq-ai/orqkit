import type { Output } from "@orq-ai/node/models/operations";

export interface RawAgentListItem {
  _id: string;
  key: string;
  display_name: string;
  status: string;
}

export interface OrqCredentials {
  apiKey: string;
}

export interface ApiError extends Error {
  response?: { status?: number; data?: { message?: string } };
  statusCode?: number;
  description?: string;
}

// Broadly matches any Error so the catch block can extract .message;
// API-specific fields (response, statusCode) are safely optional-chained at call sites.
export function isApiError(error: unknown): error is ApiError {
  return error instanceof Error;
}

export interface ConversationParam {
  id: string;
}

export interface MemoryParam {
  entity_id: string;
}

export type VariableValue = string | { secret: true; value: string };

// Local request-body shape — the SDK's CreateResponseRequestBody in 4.7.7 does
// not yet model conversation, memory, or variables (V3 alpha fields). Keep this
// local until the SDK covers them; then swap this type for the SDK's.
export interface CreateResponseBody {
  model: string;
  input: string;
  stream?: boolean;
  store?: boolean;
  previous_response_id?: string;
  conversation?: ConversationParam;
  memory?: MemoryParam;
  variables?: Record<string, VariableValue>;
  metadata?: Record<string, string>;
}

// Local response-body shape in wire snake_case. The SDK's CreateResponseResponseBody
// is camelCase (post-deserialization) and its status enum is missing "requires_action"
// which the V3 server does emit (e.g. agents with function tools). Nested output items
// (Output / Content1 / refusal content) are wire-compatible though, so we pull those
// from the SDK.
export interface ResponseUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  [key: string]: unknown;
}

export interface ResponseError {
  message?: string;
  code?: string;
  [key: string]: unknown;
}

export interface ResponseIncompleteDetails {
  reason?: string;
  [key: string]: unknown;
}

export interface ResponseBody {
  id: string;
  status: string;
  output?: Output[];
  error?: ResponseError | null;
  usage?: ResponseUsage | null;
  incomplete_details?: ResponseIncompleteDetails | null;
  [key: string]: unknown;
}
