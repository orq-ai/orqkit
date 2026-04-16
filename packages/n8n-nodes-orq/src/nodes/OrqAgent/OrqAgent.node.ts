import type {
  IDataObject,
  IExecuteFunctions,
  ILoadOptionsFunctions,
  INodeExecutionData,
  INodePropertyOptions,
  INodeType,
  INodeTypeDescription,
} from "n8n-workflow";
import { NodeOperationError } from "n8n-workflow";

import { createResponse, getAgentKeys } from "./api-service";
import { buildCreateResponseBody } from "./builders";
import { DEFAULT_RESPONSE_TIMEOUT_SECONDS, ERROR_MESSAGES } from "./constants";
import { allProperties } from "./node-properties";
import type {
  OrqCredentials,
  ResponseOutputItem,
  ResponseResource,
} from "./types";
import { isApiError } from "./types";
import {
  isOutputMessage,
  isOutputTextContent,
  isRefusalContent,
  Validators,
} from "./validators";

interface ExtractedOutput {
  text: string;
  refusals: string[];
}

function extractOutput(
  output: ResponseOutputItem[] | undefined,
): ExtractedOutput {
  const textChunks: string[] = [];
  const refusals: string[] = [];

  for (const item of output ?? []) {
    if (!isOutputMessage(item)) continue;
    for (const content of item.content) {
      if (isOutputTextContent(content)) {
        textChunks.push(content.text);
      } else if (isRefusalContent(content)) {
        refusals.push(content.refusal);
      }
    }
  }

  return { text: textChunks.join("\n"), refusals };
}

export class OrqAgent implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Orq Agent",
    name: "orqAgent",
    icon: "file:orq.svg",
    group: ["transform"],
    version: 1,
    subtitle: '={{"Invoke: " + $parameter["agentKey"]}}',
    description: "Invoke an Orq AI Agent",
    defaults: {
      name: "Orq Agent",
    },
    inputs: ["main"],
    outputs: ["main"],
    credentials: [
      {
        name: "orqApi",
        required: true,
      },
    ],
    properties: allProperties,
  };

  methods = {
    loadOptions: {
      async getAgentKeys(
        this: ILoadOptionsFunctions,
      ): Promise<INodePropertyOptions[]> {
        return getAgentKeys(this);
      },
    },
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const returnData: INodeExecutionData[] = [];

    for (let i = 0; i < items.length; i++) {
      try {
        const agentKey = this.getNodeParameter("agentKey", i) as string;
        const messageText = this.getNodeParameter("message", i) as string;
        const additionalFields = this.getNodeParameter(
          "additionalFields",
          i,
          {},
        ) as {
          previousResponseId?: string;
          conversationId?: string;
        };
        const rawTimeoutSeconds = this.getNodeParameter(
          "timeoutSeconds",
          i,
          DEFAULT_RESPONSE_TIMEOUT_SECONDS,
        ) as number;
        const timeoutSeconds =
          rawTimeoutSeconds && rawTimeoutSeconds > 0
            ? rawTimeoutSeconds
            : DEFAULT_RESPONSE_TIMEOUT_SECONDS;
        const timeoutMs = timeoutSeconds * 1000;

        Validators.validateAgentKey(agentKey, this.getNode());
        Validators.validateMessage(messageText, this.getNode());
        Validators.validateThreadingExclusivity(
          additionalFields.previousResponseId,
          additionalFields.conversationId,
          this.getNode(),
        );

        const credentials = (await this.getCredentials(
          "orqApi",
        )) as OrqCredentials;
        Validators.validateCredentials(credentials, this.getNode());

        const body = buildCreateResponseBody({
          agentKey,
          input: messageText,
          previousResponseId: additionalFields.previousResponseId,
          conversationId: additionalFields.conversationId,
        });

        const resp: ResponseResource = await createResponse(
          this,
          body,
          timeoutMs,
        );

        const status = resp.status;

        if (status === "failed") {
          throw new NodeOperationError(
            this.getNode(),
            ERROR_MESSAGES.RESPONSE_FAILED(
              resp.error?.message ?? "unknown error",
            ),
          );
        }

        if (status === "requires_action") {
          throw new NodeOperationError(
            this.getNode(),
            ERROR_MESSAGES.RESPONSE_REQUIRES_ACTION,
          );
        }

        if (status !== "completed" && status !== "incomplete") {
          throw new NodeOperationError(
            this.getNode(),
            ERROR_MESSAGES.RESPONSE_UNEXPECTED_STATUS(status ?? "unknown"),
          );
        }

        const { text, refusals } = extractOutput(resp.output);

        const responseData: IDataObject = {
          responseId: resp.id,
          agentKey,
          status,
          success: status === "completed",
          response: text,
          raw: resp as unknown as IDataObject,
        };

        if (resp.usage) {
          responseData.usage = resp.usage as IDataObject;
        }

        if (refusals.length > 0) {
          responseData.refusals = refusals;
        }

        if (status === "incomplete") {
          responseData.incomplete = true;
          responseData.incompleteReason =
            resp.incomplete_details?.reason ?? "unknown";
        }

        returnData.push({
          json: responseData,
          pairedItem: { item: i },
        });
      } catch (error: unknown) {
        if (error instanceof NodeOperationError) {
          if (this.continueOnFail()) {
            returnData.push({
              json: { error: error.message },
              pairedItem: { item: i },
            });
            continue;
          }
          throw error;
        }

        const errorObj = isApiError(error) ? error : null;
        const message = errorObj?.message || "Request failed";

        if (this.continueOnFail()) {
          returnData.push({
            json: {
              error: message,
              statusCode:
                errorObj?.response?.status || errorObj?.statusCode || "Unknown",
              details:
                errorObj?.response?.data || errorObj?.description || undefined,
            },
            pairedItem: { item: i },
          });
          continue;
        }

        throw new NodeOperationError(
          this.getNode(),
          ERROR_MESSAGES.RESPONSE_REQUEST_FAILED(message),
          {
            description:
              errorObj?.response?.data?.message ??
              errorObj?.description ??
              "No additional details",
          },
        );
      }
    }

    return [returnData];
  }
}
