import type {
  IExecuteFunctions,
  ILoadOptionsFunctions,
  INodePropertyOptions,
} from "n8n-workflow";
import { NodeOperationError } from "n8n-workflow";

import type {
  InvokeAgentA2ATaskResponse,
  InvokeAgentRequestBody,
} from "@orq-ai/node/models/operations";

import {
  AGENT_INVOKE_ENDPOINT,
  AGENT_TASK_ENDPOINT,
  AGENT_TASK_MESSAGES_ENDPOINT,
  AGENTS_LIST_ENDPOINT,
  DEFAULT_BASE_URL,
  ERROR_MESSAGES,
  MAX_CONSECUTIVE_POLL_ERRORS,
  MAX_PAGES,
  MAX_POLL_ATTEMPTS,
  PAGE_SIZE,
  POLL_INTERVAL_MS,
} from "./constants";
import type { PaginatedResponse, RawAgentListItem, RawTaskMessage } from "./types";
import { TERMINAL_TASK_STATES } from "./types";

async function fetchAllPages<T extends { _id: string }>(
  context: ILoadOptionsFunctions | IExecuteFunctions,
  baseUrl: string,
): Promise<T[]> {
  const results: T[] = [];
  let cursor: string | undefined;
  let pages = 0;

  do {
    const url = cursor
      ? `${baseUrl}?limit=${PAGE_SIZE}&starting_after=${cursor}`
      : `${baseUrl}?limit=${PAGE_SIZE}`;

    const response = (await context.helpers.requestWithAuthentication.call(
      context,
      "orqApi",
      { method: "GET", url, json: true },
    )) as PaginatedResponse<T>;

    const page = response?.data ?? [];
    results.push(...page);

    pages++;

    cursor =
      response?.has_more && page.length > 0 && pages < MAX_PAGES
        ? page[page.length - 1]._id
        : undefined;
  } while (cursor);

  return results;
}

export async function getAgentKeys(
  context: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
  try {
    const agents = await fetchAllPages<RawAgentListItem>(
      context,
      `${DEFAULT_BASE_URL}${AGENTS_LIST_ENDPOINT}`,
    );

    return agents.map((agent) => ({
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

export async function invokeAgent(
  context: IExecuteFunctions,
  agentKey: string,
  body: InvokeAgentRequestBody,
): Promise<InvokeAgentA2ATaskResponse> {
  return await context.helpers.requestWithAuthentication.call(
    context,
    "orqApi",
    {
      method: "POST",
      url: `${DEFAULT_BASE_URL}${AGENT_INVOKE_ENDPOINT(agentKey)}`,
      body,
      json: true,
    },
  );
}

export async function getTaskStatus(
  context: IExecuteFunctions,
  agentKey: string,
  taskId: string,
): Promise<InvokeAgentA2ATaskResponse> {
  return await context.helpers.requestWithAuthentication.call(
    context,
    "orqApi",
    {
      method: "GET",
      url: `${DEFAULT_BASE_URL}${AGENT_TASK_ENDPOINT(agentKey, taskId)}`,
      json: true,
    },
  );
}

export async function getTaskMessages(
  context: IExecuteFunctions,
  agentKey: string,
  taskId: string,
): Promise<RawTaskMessage[]> {
  return fetchAllPages<RawTaskMessage>(
    context,
    `${DEFAULT_BASE_URL}${AGENT_TASK_MESSAGES_ENDPOINT(agentKey, taskId)}`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pollTaskUntilDone(
  context: IExecuteFunctions,
  agentKey: string,
  taskId: string,
): Promise<InvokeAgentA2ATaskResponse> {
  let consecutiveErrors = 0;

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    try {
      const task = await getTaskStatus(context, agentKey, taskId);
      consecutiveErrors = 0;
      const state = task.status?.state;

      if (state && TERMINAL_TASK_STATES.includes(state)) {
        return task;
      }
    } catch (error) {
      consecutiveErrors++;
      if (consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
        throw error;
      }
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new NodeOperationError(
    context.getNode(),
    ERROR_MESSAGES.TASK_POLL_TIMEOUT,
  );
}
