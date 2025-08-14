import type { IExecuteFunctions } from "n8n-workflow";

import { FilterBuilder } from "./filter-builder";
import type { IOrqKnowledgeBaseSearchRequest } from "./types";
import { InputValidator } from "./validators";

interface AdditionalOptions {
  top_k?: number;
  threshold?: number;
  search_type?: string;
}

export function buildSearchRequest(
  context: IExecuteFunctions,
  itemIndex: number,
): IOrqKnowledgeBaseSearchRequest {
  const query = context.getNodeParameter("query", itemIndex) as string;
  const additionalOptions = context.getNodeParameter(
    "additionalOptions",
    itemIndex,
    {},
  ) as AdditionalOptions;

  const request: IOrqKnowledgeBaseSearchRequest = {
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
    request.filter_by = filter;
  }

  return request;
}

export const RequestBuilder = {
  buildSearchRequest,
};
