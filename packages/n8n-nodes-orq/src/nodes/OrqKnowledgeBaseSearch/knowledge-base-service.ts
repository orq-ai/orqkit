import type {
  IExecuteFunctions,
  IHttpRequestOptions,
  ILoadOptionsFunctions,
  INodePropertyOptions,
} from "n8n-workflow";

import type { SearchKnowledgeResponseBody } from "@orq-ai/node/models/operations";

import { fetchAllPages } from "../../lib/pagination";
import { API_ENDPOINTS } from "./constants";
import { ApiError } from "./errors";
import type { ApiSearchRequest } from "./request-builder";
import type { IOrqKnowledgeBase, RawKnowledgeBase } from "./types";

const DEFAULT_TIMEOUT = 30000;

interface ErrorWithStatusCode {
  statusCode?: number;
  message?: string;
  responseBody?: unknown;
}

export async function getKnowledgeBases(
  context: ILoadOptionsFunctions | IExecuteFunctions,
): Promise<IOrqKnowledgeBase[]> {
  try {
    const knowledgeBases = await fetchAllPages<RawKnowledgeBase>(
      context,
      `${API_ENDPOINTS.BASE_URL}${API_ENDPOINTS.KNOWLEDGE_BASES}`,
    );

    return knowledgeBases.map((kb) => ({
      id: kb.id || kb._id,
      name: kb.key || kb.id || kb._id,
      description: kb.description,
    }));
  } catch (error) {
    const errorObj = error as ErrorWithStatusCode;
    if (errorObj.statusCode) {
      throw new ApiError(
        context.getNode(),
        getErrorMessage("fetch knowledge bases", errorObj),
        errorObj.statusCode,
        errorObj.responseBody,
      );
    }
    throw error;
  }
}

export async function getKnowledgeBaseOptions(
  context: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
  try {
    const knowledgeBases = await getKnowledgeBases(context);
    return knowledgeBases.map((kb) => ({
      name: kb.name || kb.id,
      value: kb.id,
      description: kb.description,
    }));
  } catch {
    return [];
  }
}

export async function searchKnowledgeBase(
  context: IExecuteFunctions,
  knowledgeId: string,
  searchRequest: ApiSearchRequest,
): Promise<SearchKnowledgeResponseBody> {
  const endpoint = API_ENDPOINTS.KNOWLEDGE_BASE_SEARCH.replace(
    "{knowledge_id}",
    encodeURIComponent(knowledgeId),
  );
  const options: IHttpRequestOptions = {
    method: "POST",
    baseURL: API_ENDPOINTS.BASE_URL,
    url: endpoint,
    body: searchRequest,
    json: true,
    timeout: DEFAULT_TIMEOUT,
  };

  try {
    const response = await context.helpers.requestWithAuthentication.call(
      context,
      "orqApi",
      options,
    );

    return validateSearchResponse(response);
  } catch (error) {
    const errorObj = error as ErrorWithStatusCode;
    if (errorObj.statusCode) {
      throw new ApiError(
        context.getNode(),
        getErrorMessage("search knowledge base", errorObj),
        errorObj.statusCode,
        errorObj.responseBody,
      );
    }
    throw error;
  }
}

function validateSearchResponse(
  response: unknown,
): SearchKnowledgeResponseBody {
  if (!response || typeof response !== "object") {
    throw new Error("Invalid response format from Orq API");
  }
  return response as SearchKnowledgeResponseBody;
}

function getErrorMessage(
  operation: string,
  error: ErrorWithStatusCode,
): string {
  const baseMessage = `Failed to ${operation}`;

  if (error.statusCode === 401) {
    return `${baseMessage}: Invalid API key or unauthorized access`;
  }
  if (error.statusCode === 404) {
    return `${baseMessage}: Resource not found`;
  }
  if (error.statusCode === 400) {
    return `${baseMessage}: Invalid request - ${error.message || "Bad request"}`;
  }
  if (error.statusCode && error.statusCode >= 500) {
    return `${baseMessage}: Orq API server error`;
  }

  return `${baseMessage}: ${error.message || "Unknown error"}`;
}
