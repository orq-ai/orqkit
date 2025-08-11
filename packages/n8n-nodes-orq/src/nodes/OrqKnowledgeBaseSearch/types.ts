import type { IDataObject } from "n8n-workflow";

export interface FilterOperator {
  eq?: string | number | boolean;
  ne?: string | number | boolean;
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
  in?: (string | number | boolean)[];
  nin?: (string | number | boolean)[];
}

export interface SearchFilterRecord {
  [key: string]: string | number | boolean | FilterOperator;
}

export interface AndFilter {
  and: (SearchFilterRecord | AndFilter | OrFilter)[];
}

export interface OrFilter {
  or: (SearchFilterRecord | AndFilter | OrFilter)[];
}

export type SearchFilter = SearchFilterRecord | AndFilter | OrFilter;

export interface IOrqKnowledgeBaseSearchRequest {
  query: string;
  top_k?: number;
  threshold?: number;
  filter_by?: SearchFilter;
  search_options?: {
    include_scores?: boolean;
    include_metadata?: boolean;
    include_vectors?: boolean;
  };
}

export interface IOrqKnowledgeBaseSearchResponse {
  results: ISearchResult[];
}

export interface ISearchResult {
  content: string;
  score: number;
  metadata?: IDataObject;
  chunk_id?: string;
  document_id?: string;
  search_score?: number;
  rerank_score?: number;
}

export interface IOrqKnowledgeBase {
  id: string;
  name: string;
  description?: string;
}

export interface IOrqKnowledgeBaseApiResponse {
  _id: string;
  key: string;
  description?: string | null;
  created: string;
  created_by_id: string;
  model: string;
  domain_id: string;
  path: string;
  retrieval_settings: {
    retrieval_type: string;
    top_k: number;
    threshold: number;
  };
  update_by_id: string;
  updated: string;
}

export interface IOrqKnowledgeBaseListResponse {
  object: string;
  data: IOrqKnowledgeBaseApiResponse[];
  has_more: boolean;
}
