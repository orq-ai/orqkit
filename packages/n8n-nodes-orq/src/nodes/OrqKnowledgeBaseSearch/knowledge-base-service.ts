import type {
  IExecuteFunctions,
  IHttpRequestOptions,
  ILoadOptionsFunctions,
  INodePropertyOptions,
} from "n8n-workflow";

import { API_ENDPOINTS } from "./constants";
import { ApiError } from "./errors";
import type {
  IOrqKnowledgeBase,
  IOrqKnowledgeBaseApiResponse,
  IOrqKnowledgeBaseListResponse,
  IOrqKnowledgeBaseSearchRequest,
  IOrqKnowledgeBaseSearchResponse,
} from "./types";
import { InputValidator } from "./validators";

const DEFAULT_TIMEOUT = 30000;

interface ErrorWithStatusCode {
  statusCode?: number;
  message?: string;
  responseBody?: unknown;
}

export async function getKnowledgeBases(
  context: ILoadOptionsFunctions | IExecuteFunctions,
): Promise<IOrqKnowledgeBase[]> {
  const options: IHttpRequestOptions = {
    method: "GET",
    url: `${API_ENDPOINTS.BASE_URL}${API_ENDPOINTS.KNOWLEDGE_BASES}`,
    json: true,
    timeout: DEFAULT_TIMEOUT,
  };

  try {
    const response = await context.helpers.requestWithAuthentication.call(
      context,
      "orqApi",
      options,
    );

    return parseKnowledgeBasesResponse(response);
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
  searchRequest: IOrqKnowledgeBaseSearchRequest,
): Promise<IOrqKnowledgeBaseSearchResponse> {
  const validatedId = InputValidator.validateKnowledgeBaseId(
    context.getNode(),
    knowledgeId,
  );
  const validatedRequest = InputValidator.validateSearchRequest(
    context.getNode(),
    searchRequest,
  );

  const endpoint = API_ENDPOINTS.KNOWLEDGE_BASE_SEARCH.replace(
    "{knowledge_id}",
    validatedId,
  );
  const options: IHttpRequestOptions = {
    method: "POST",
    url: `${API_ENDPOINTS.BASE_URL}${endpoint}`,
    body: validatedRequest,
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

function parseKnowledgeBasesResponse(response: unknown): IOrqKnowledgeBase[] {
  if (!response) return [];

  if (isOrqApiResponse(response)) {
    const apiResponse = response as IOrqKnowledgeBaseListResponse;
    return apiResponse.data.map((kb) => mapApiResponseToKnowledgeBase(kb));
  }
  if (Array.isArray(response)) {
    return response;
  }

  return [];
}

function isOrqApiResponse(
  response: unknown,
): response is IOrqKnowledgeBaseListResponse {
  return Boolean(
    response &&
      typeof response === "object" &&
      "data" in response &&
      Array.isArray((response as { data?: unknown }).data),
  );
}

function mapApiResponseToKnowledgeBase(
  kb: IOrqKnowledgeBaseApiResponse,
): IOrqKnowledgeBase {
  return {
    id: kb._id || "",
    name: kb.key || kb._id || "Unnamed Knowledge Base",
    description: kb.description || undefined,
  };
}

function validateSearchResponse(
  response: unknown,
): IOrqKnowledgeBaseSearchResponse {
  if (!response || typeof response !== "object") {
    throw new Error("Invalid response format from Orq API");
  }
  return response as IOrqKnowledgeBaseSearchResponse;
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
