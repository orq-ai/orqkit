import type {
  IExecuteFunctions,
  ILoadOptionsFunctions,
  INodePropertyOptions,
} from "n8n-workflow";
import { NodeOperationError } from "n8n-workflow";

import {
  AGENT_INVOKE_ENDPOINT,
  AGENT_TASK_ENDPOINT,
  AGENT_TASK_MESSAGES_ENDPOINT,
  AGENTS_LIST_ENDPOINT,
  DEFAULT_BASE_URL,
  ERROR_MESSAGES,
  MAX_POLL_ATTEMPTS,
  POLL_INTERVAL_MS,
} from "./constants";
import { TERMINAL_TASK_STATES } from "./types";
import type {
  OrqAgent,
  OrqAgentInvokeRequest,
  OrqAgentListResponse,
  OrqTask,
  OrqTaskMessagesResponse,
} from "./types";

export async function getAgentKeys(
  context: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
  const requestUrl = `${DEFAULT_BASE_URL}${AGENTS_LIST_ENDPOINT}?limit=50`;
  try {
    const response = (await context.helpers.requestWithAuthentication.call(
      context,
      "orqApi",
      {
        method: "GET",
        url: requestUrl,
        json: true,
      },
    )) as OrqAgentListResponse;

    return response.data.map((agent: OrqAgent) => ({
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
  body: OrqAgentInvokeRequest,
): Promise<OrqTask> {
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
): Promise<OrqTask> {
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
): Promise<OrqTaskMessagesResponse> {
  return await context.helpers.requestWithAuthentication.call(
    context,
    "orqApi",
    {
      method: "GET",
      url: `${DEFAULT_BASE_URL}${AGENT_TASK_MESSAGES_ENDPOINT(agentKey, taskId)}`,
      json: true,
    },
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pollTaskUntilDone(
  context: IExecuteFunctions,
  agentKey: string,
  taskId: string,
): Promise<OrqTask> {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    const task = await getTaskStatus(context, agentKey, taskId);
    const state = task.status?.state;

    if (TERMINAL_TASK_STATES.includes(state)) {
      return task;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new NodeOperationError(
    context.getNode(),
    ERROR_MESSAGES.TASK_POLL_TIMEOUT,
  );
}
