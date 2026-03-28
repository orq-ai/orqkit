import type { IExecuteFunctions } from "n8n-workflow";

import type { FilterBy } from "@orq-ai/node/models/operations";

import { FilterBuilder } from "./filter-builder";
import { InputValidator } from "./validators";

interface AdditionalOptions {
  top_k?: number;
  threshold?: number;
  search_type?: string;
}

export interface ApiSearchRequest {
  query: string;
  top_k?: number;
  threshold?: number;
  search_type?: string;
  filter_by?: FilterBy;
  search_options?: {
    include_scores?: boolean;
    include_metadata?: boolean;
    include_vectors?: boolean;
  };
}

export function buildSearchRequest(
  context: IExecuteFunctions,
  itemIndex: number,
): ApiSearchRequest {
  const query = context.getNodeParameter("query", itemIndex) as string;
  const additionalOptions = context.getNodeParameter(
    "additionalOptions",
    itemIndex,
    {},
  ) as AdditionalOptions;

  const request: ApiSearchRequest = {
    query: InputValidator.validateQuery(context.getNode(), query),
  };

  if (additionalOptions.top_k !== undefined) {
    request.top_k = InputValidator.validateTopK(
      context.getNode(),
      additionalOptions.top_k,
    );
  }

  if (
    additionalOptions.threshold !== undefined &&
    additionalOptions.threshold !== null
  ) {
    request.threshold = InputValidator.validateThreshold(
      context.getNode(),
      additionalOptions.threshold,
    );
  }

  if (additionalOptions.search_type !== undefined) {
    request.search_type = additionalOptions.search_type;
  }

  const metadataFilterType = context.getNodeParameter(
    "metadataFilterType",
    itemIndex,
    "none",
  ) as string;

  request.search_options = {
    include_scores: true,
    include_metadata: metadataFilterType !== "none",
    include_vectors: false,
  };

  const filter = FilterBuilder.buildFilter(
    context,
    metadataFilterType,
    itemIndex,
  );
  if (filter) {
    request.filter_by = filter as FilterBy;
  }

  return request;
}

export const RequestBuilder = {
  buildSearchRequest,
};
