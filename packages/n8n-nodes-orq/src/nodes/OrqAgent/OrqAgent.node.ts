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

import type { TaskStatusMessage } from "@orq-ai/node/models/operations";

import {
  getAgentKeys,
  getTaskMessages,
  invokeAgent,
  pollTaskUntilDone,
} from "./api-service";
import { buildInvokeRequestBody } from "./builders";
import { ERROR_MESSAGES } from "./constants";
import { allProperties } from "./node-properties";
import type { OrqCredentials } from "./types";
import { isApiError } from "./types";
import { isTextPart, Validators } from "./validators";

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

        Validators.validateAgentKey(agentKey, this.getNode());
        Validators.validateMessage(messageText, this.getNode());

        const credentials = (await this.getCredentials(
          "orqApi",
        )) as OrqCredentials;
        Validators.validateCredentials(credentials, this.getNode());

        const body = buildInvokeRequestBody(messageText);
        const task = await invokeAgent(this, agentKey, body);

        if (!task.id) {
          throw new NodeOperationError(
            this.getNode(),
            "Agent invoke did not return a task ID",
          );
        }

        const completedTask = await pollTaskUntilDone(this, agentKey, task.id);
        const finalState = completedTask.status?.state;

        if (finalState !== "completed") {
          throw new NodeOperationError(
            this.getNode(),
            ERROR_MESSAGES.TASK_FAILED(finalState ?? "unknown"),
          );
        }

        const messages = await getTaskMessages(this, agentKey, task.id);

        const agentMessages = messages.filter(
          (m: TaskStatusMessage) => m.role !== "user",
        );
        const responseText = agentMessages
          .flatMap((m: TaskStatusMessage) =>
            m.parts.filter(isTextPart).map((p) => p.text),
          )
          .join("\n");

        const responseData: IDataObject = {
          taskId: task.id,
          agentKey,
          status: finalState,
          success: true,
          response: responseText,
          messages: messages as unknown as IDataObject[],
        };

        returnData.push({
          json: responseData,
          pairedItem: { item: i },
        });
      } catch (error: unknown) {
        if (error instanceof NodeOperationError) {
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
          ERROR_MESSAGES.AGENT_INVOKE_FAILED(message),
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
