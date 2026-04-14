import type {
  IExecuteFunctions,
  ILoadOptionsFunctions,
  INodePropertyOptions,
} from "n8n-workflow";
import { NodeOperationError } from "n8n-workflow";

import { fetchAllPages } from "../../lib/pagination";
import {
  AGENTS_LIST_ENDPOINT,
  DEFAULT_BASE_URL,
  ERROR_MESSAGES,
  RESPONSES_ENDPOINT,
} from "./constants";
import type {
  CreateResponseBody,
  RawAgentListItem,
  ResponseResource,
} from "./types";

export async function getAgentKeys(
  context: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
  try {
    const agents = await fetchAllPages<RawAgentListItem>(
      context,
      `${DEFAULT_BASE_URL}${AGENTS_LIST_ENDPOINT}`,
      200,
    );

    return agents
      .filter((agent) => agent.status === "live")
      .map((agent) => ({
        name: agent.display_name || agent.key,
        value: agent.key,
      }));
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    throw new NodeOperationError(
      context.getNode(),
      ERROR_MESSAGES.FETCH_AGENTS_FAILED(errorMessage),
    );
  }
}

export async function createResponse(
  context: IExecuteFunctions,
  body: CreateResponseBody,
  timeoutMs: number,
): Promise<ResponseResource> {
  return await context.helpers.requestWithAuthentication.call(
    context,
    "orqApi",
    {
      method: "POST",
      url: `${DEFAULT_BASE_URL}${RESPONSES_ENDPOINT}`,
      body,
      json: true,
      timeout: timeoutMs,
    },
  );
}
