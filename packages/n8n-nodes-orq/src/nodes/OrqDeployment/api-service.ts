import type {
  IExecuteFunctions,
  ILoadOptionsFunctions,
  INodePropertyOptions,
} from "n8n-workflow";
import { NodeOperationError } from "n8n-workflow";

import type { InvokeDeploymentRequest } from "@orq-ai/node/models/components";
import type { DeploymentInvokeResponseBody } from "@orq-ai/node/models/operations/deploymentinvoke";

import { fetchAllPages } from "../../lib/pagination";
import {
  DEFAULT_BASE_URL,
  DEPLOYMENT_INVOKE_ENDPOINT,
  DEPLOYMENTS_LIST_ENDPOINT,
  ERROR_MESSAGES,
} from "./constants";
import type { RawDeploymentListItem } from "./types";

export async function getDeploymentKeys(
  context: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
  try {
    const deployments = await fetchAllPages<RawDeploymentListItem>(
      context,
      `${DEFAULT_BASE_URL}${DEPLOYMENTS_LIST_ENDPOINT}`,
    );

    return deployments.map((deployment) => ({
      name: deployment.key,
      value: deployment.key,
    }));
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    throw new NodeOperationError(
      context.getNode(),
      ERROR_MESSAGES.FETCH_DEPLOYMENTS_FAILED(errorMessage),
    );
  }
}

export async function invokeDeployment(
  context: IExecuteFunctions,
  body: InvokeDeploymentRequest,
): Promise<DeploymentInvokeResponseBody> {
  const baseUrl = DEFAULT_BASE_URL;

  return await context.helpers.requestWithAuthentication.call(
    context,
    "orqApi",
    {
      method: "POST",
      url: `${baseUrl}${DEPLOYMENT_INVOKE_ENDPOINT}`,
      body,
      json: true,
    },
  );
}
