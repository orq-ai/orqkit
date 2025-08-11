import type { INode } from "n8n-workflow";

import { SEARCH_CONFIG } from "./constants";
import { ValidationError } from "./errors";
import type { IOrqKnowledgeBaseSearchRequest } from "./types";

export function validateKnowledgeBaseId(
  node: INode,
  knowledgeBase: unknown,
): string {
  if (
    !knowledgeBase ||
    typeof knowledgeBase !== "string" ||
    !knowledgeBase.trim()
  ) {
    throw new ValidationError(
      node,
      "Knowledge base ID is required",
      "knowledgeBase",
    );
  }
  return knowledgeBase.trim();
}

export function validateQuery(node: INode, query: unknown): string {
  if (!query || typeof query !== "string") {
    throw new ValidationError(
      node,
      "Query is required and must be a string",
      "query",
    );
  }

  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    throw new ValidationError(
      node,
      "Query cannot be empty or whitespace only",
      "query",
    );
  }

  if (trimmedQuery.length > SEARCH_CONFIG.MAX_QUERY_LENGTH) {
    throw new ValidationError(
      node,
      `Query is too long. Maximum length is ${SEARCH_CONFIG.MAX_QUERY_LENGTH} characters`,
      "query",
    );
  }

  return trimmedQuery;
}

export function validateTopK(
  node: INode,
  topK: unknown,
): number | undefined {
  if (topK === undefined || topK === null || topK === "") {
    return undefined;
  }

  const value = parseInt(String(topK), 10);
  if (
    Number.isNaN(value) ||
    value < SEARCH_CONFIG.MIN_TOP_K ||
    value > SEARCH_CONFIG.MAX_TOP_K
  ) {
    throw new ValidationError(
      node,
      `Chunk limit (top_k) must be an integer between ${SEARCH_CONFIG.MIN_TOP_K} and ${SEARCH_CONFIG.MAX_TOP_K}`,
      "top_k",
    );
  }

  return value;
}

export function validateThreshold(
  node: INode,
  threshold: unknown,
): number | undefined {
  if (threshold === undefined || threshold === null || threshold === "") {
    return undefined;
  }

  const value = parseFloat(String(threshold));
  if (
    Number.isNaN(value) ||
    value < SEARCH_CONFIG.MIN_THRESHOLD ||
    value > SEARCH_CONFIG.MAX_THRESHOLD
  ) {
    throw new ValidationError(
      node,
      `Threshold must be a number between ${SEARCH_CONFIG.MIN_THRESHOLD} and ${SEARCH_CONFIG.MAX_THRESHOLD}`,
      "threshold",
    );
  }

  return value;
}

export function validateSearchRequest(
  node: INode,
  request: IOrqKnowledgeBaseSearchRequest,
): IOrqKnowledgeBaseSearchRequest {
  const validated: IOrqKnowledgeBaseSearchRequest = {
    query: validateQuery(node, request.query),
  };

  if (request.top_k !== undefined) {
    validated.top_k = validateTopK(node, request.top_k);
  }

  if (request.threshold !== undefined) {
    validated.threshold = validateThreshold(node, request.threshold);
  }

  if (request.filter_by !== undefined) {
    validated.filter_by = request.filter_by;
  }

  if (request.search_options !== undefined) {
    validated.search_options = request.search_options;
  }

  return validated;
}

export function parseArrayValue(value: string): (string | number)[] {
  return value.split(",").map((v: string) => {
    const trimmed = v.trim();
    const num = Number(trimmed);
    return Number.isNaN(num) ? trimmed : num;
  });
}

export function parseValue(value: unknown): string | number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const num = Number(value);
    return Number.isNaN(num) ? value : num;
  }
  return String(value);
}

// Export for backward compatibility if needed
export const InputValidator = {
  validateKnowledgeBaseId,
  validateQuery,
  validateTopK,
  validateThreshold,
  validateSearchRequest,
  parseArrayValue,
  parseValue,
};