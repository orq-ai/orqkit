import type { INode } from "n8n-workflow";

import type {
  OrqContentItem,
  OrqContextProperty,
  OrqFixedCollectionContext,
  OrqFixedCollectionInputs,
  OrqFixedCollectionMessages,
  OrqInputMessage,
  OrqInputProperty,
  OrqRequestBody,
} from "./types";
import { Validators } from "./validators";

export function buildMessages(
  messagesData: OrqFixedCollectionMessages,
): OrqInputMessage[] {
  const messages: OrqInputMessage[] = [];

  if (messagesData?.messageProperty?.length) {
    for (const item of messagesData.messageProperty) {
      if (!item.role) continue;

      const message: OrqInputMessage = {
        role: item.role,
        content: "",
      };

      if (
        item.role === "user" &&
        item.contentType &&
        item.contentType !== "text"
      ) {
        const contentItems: OrqContentItem[] = [];

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
            } as OrqContentItem);
          } else if (item.imageSource === "url" && item.imageUrl) {
            contentItems.push({
              type: "image_url",
              image_url: {
                url: item.imageUrl.trim(),
              },
            } as OrqContentItem);
          } else if (!item.imageSource && item.imageUrl) {
            contentItems.push({
              type: "image_url",
              image_url: {
                url: item.imageUrl.trim(),
              },
            } as OrqContentItem);
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
  messages: OrqInputMessage[],
  context?: Record<string, string>,
  inputs?: Record<string, string>,
): OrqRequestBody {
  const body: OrqRequestBody = {
    key: deploymentKey,
    messages: messages,
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
