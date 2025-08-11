import type {
  IDataObject,
  IExecuteFunctions,
  ILoadOptionsFunctions,
  INodeExecutionData,
  INodePropertyOptions,
  INodeType,
  INodeTypeDescription,
} from "n8n-workflow";

import { OrqError } from "./errors";
import {
  getKnowledgeBaseOptions,
  searchKnowledgeBase,
} from "./knowledge-base-service";
import { knowledgeBaseSearchProperties } from "./node-properties";
import { RequestBuilder } from "./request-builder";
import type { IOrqKnowledgeBaseSearchRequest } from "./types";
import { InputValidator } from "./validators";

export class OrqKnowledgeBaseSearch implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Orq Knowledge Base Search",
    name: "orqKnowledgeBaseSearch",
    icon: "file:orq.svg",
    group: ["transform"],
    version: 1,
    description: "Search content in an Orq.ai knowledge base",
    defaults: {
      name: "Orq Knowledge Base Search",
    },
    inputs: ["main"],
    outputs: ["main"],
    credentials: [
      {
        name: "orqApi",
        required: true,
      },
    ],
    properties: knowledgeBaseSearchProperties,
  };

  methods = {
    loadOptions: {
      async getKnowledgeBases(
        this: ILoadOptionsFunctions,
      ): Promise<INodePropertyOptions[]> {
        return getKnowledgeBaseOptions(this);
      },
    },
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const returnData: INodeExecutionData[] = [];

    for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
      let knowledgeBaseId = "";
      let searchRequest: IOrqKnowledgeBaseSearchRequest = { query: "" };

      try {
        knowledgeBaseId = InputValidator.validateKnowledgeBaseId(
          this.getNode(),
          this.getNodeParameter("knowledgeBase", itemIndex),
        );

        searchRequest = RequestBuilder.buildSearchRequest(this, itemIndex);

        const response = await searchKnowledgeBase(
          this,
          knowledgeBaseId,
          searchRequest,
        );

        const outputData = {
          ...response,
        };

        returnData.push({
          json: outputData,
          pairedItem: { item: itemIndex },
        });
      } catch (error) {
        if (this.continueOnFail()) {
          const errorResponse =
            OrqKnowledgeBaseSearch.buildErrorResponse(error);

          returnData.push({
            json: errorResponse,
            pairedItem: { item: itemIndex },
          });
          continue;
        }
        throw error;
      }
    }

    return [returnData];
  }

  private static buildErrorResponse(error: unknown): IDataObject {
    const response: IDataObject = {
      error: error instanceof Error ? error.message : String(error),
    };

    if (error instanceof OrqError) {
      response.errorCode = error.code;
      if (error.statusCode) {
        response.statusCode = error.statusCode;
      }
      if (error.details) {
        response.details = error.details;
      }
    }

    return response;
  }
}
