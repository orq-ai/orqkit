export const API_ENDPOINTS = {
  BASE_URL: "https://api.orq.ai",
  KNOWLEDGE_BASES: "/v2/knowledge?limit=50",
  KNOWLEDGE_BASE_SEARCH: "/v2/knowledge/{knowledge_id}/search",
} as const;

export const ERROR_MESSAGES = {
  NO_KNOWLEDGE_BASE: "No knowledge base selected",
  NO_QUERY: "Search query is required",
  SEARCH_FAILED: "Failed to search knowledge base",
  INVALID_RESPONSE: "Invalid response from API",
  NO_API_KEY: "No API key provided",
  UNAUTHORIZED: "Unauthorized - check your API key",
} as const;

export const SEARCH_CONFIG = {
  DEFAULT_TOP_K: 10,
  MIN_TOP_K: 1,
  MAX_TOP_K: 20,
  DEFAULT_THRESHOLD: 0.5,
  MIN_THRESHOLD: 0,
  MAX_THRESHOLD: 1,
  MAX_QUERY_LENGTH: 10000,
} as const;

export const FILTER_OPERATORS = {
  EQUALS: "eq",
  NOT_EQUALS: "ne",
  GREATER_THAN: "gt",
  GREATER_THAN_OR_EQUALS: "gte",
  LESS_THAN: "lt",
  LESS_THAN_OR_EQUALS: "lte",
  IN: "in",
  NOT_IN: "nin",
} as const;
