import type { INode } from "n8n-workflow";

import type { InvokeDeploymentRequest } from "@orq-ai/node/models/components";

import type {
  OrqContextProperty,
  OrqFixedCollectionContext,
  OrqFixedCollectionInputs,
  OrqFixedCollectionMessages,
  OrqInputProperty,
} from "./types";
import { Validators } from "./validators";

export interface ContentItem {
  type: "text" | "image_url";
  text?: string;
  image_url?: {
    url: string;
    detail?: "low" | "high" | "auto";
  };
}

export interface InputMessage {
  role: "user" | "system" | "assistant";
  content: string | ContentItem[];
}

export function buildMessages(
  messagesData: OrqFixedCollectionMessages,
): InputMessage[] {
  const messages: InputMessage[] = [];

  if (messagesData?.messageProperty?.length) {
    for (const item of messagesData.messageProperty) {
      if (!item.role) continue;

      const message: InputMessage = {
        role: item.role,
        content: "",
      };

      if (
        item.role === "user" &&
        item.contentType &&
        item.contentType !== "text"
      ) {
        const contentItems: ContentItem[] = [];

        if (
          item.contentType === "image" &&
          item.message &&
          item.message.trim() !== ""
        ) {
          contentItems.push({
            type: "text",
            text: item.message.trim(),
          });
        }

        if (item.contentType === "image") {
          if (item.imageSource === "base64" && item.imageData) {
            let base64Data = item.imageData.trim();
            if (!base64Data.startsWith("data:")) {
              base64Data = `data:image/png;base64,${base64Data}`;
            }
            contentItems.push({
              type: "image_url",
              image_url: {
                url: base64Data,
              },
            });
          } else if (item.imageSource === "url" && item.imageUrl) {
            contentItems.push({
              type: "image_url",
              image_url: {
                url: item.imageUrl.trim(),
              },
            });
          } else if (!item.imageSource && item.imageUrl) {
            contentItems.push({
              type: "image_url",
              image_url: {
                url: item.imageUrl.trim(),
              },
            });
          }
        }

        if (contentItems.length > 0) {
          message.content = contentItems;
        } else {
          continue;
        }
      } else {
        if (!item.message || item.message.trim() === "") continue;
        message.content = item.message.trim();
      }

      messages.push(message);
    }
  }

  return messages;
}

export function buildContext(
  context: OrqFixedCollectionContext,
  node: INode,
): Record<string, string> | undefined {
  if (!context?.contextProperty?.length) {
    return undefined;
  }

  const contextObj: Record<string, string> = {};

  context.contextProperty.forEach((item: OrqContextProperty) => {
    const key = item.key?.trim();
    const value = item.value?.trim();

    if (key && value !== undefined) {
      Validators.validateKey(key, "context", node);
      contextObj[key] = value;
    }
  });

  return Object.keys(contextObj).length > 0 ? contextObj : undefined;
}

export function buildInputs(
  inputs: OrqFixedCollectionInputs,
  node: INode,
): Record<string, string> | undefined {
  if (!inputs?.inputProperty?.length) {
    return undefined;
  }

  const inputsObj: Record<string, string> = {};

  inputs.inputProperty.forEach((item: OrqInputProperty) => {
    const key = item.key?.trim();
    const value = item.value?.trim();

    if (key && value !== undefined) {
      Validators.validateKey(key, "input", node);
      inputsObj[key] = value;
    }
  });

  return Object.keys(inputsObj).length > 0 ? inputsObj : undefined;
}

export function buildRequestBody(
  deploymentKey: string,
  messages: InputMessage[],
  context?: Record<string, string>,
  inputs?: Record<string, string>,
): InvokeDeploymentRequest {
  const body: InvokeDeploymentRequest = {
    key: deploymentKey,
    messages: messages as InvokeDeploymentRequest["messages"],
  };

  if (context) {
    body.context = context;
  }

  if (inputs) {
    body.inputs = inputs;
  }

  return body;
}

// Export for backward compatibility if needed
export const MessageBuilder = {
  buildMessages,
};

export const ContextBuilder = {
  buildContext,
};

export const InputsBuilder = {
  buildInputs,
};

export const RequestBodyBuilder = {
  build: buildRequestBody,
};
