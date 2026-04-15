import type { INodeProperties } from "n8n-workflow";

import { DEFAULT_RESPONSE_TIMEOUT_MS } from "./constants";

export const agentKeyProperty: INodeProperties = {
  // eslint-disable-next-line n8n-nodes-base/node-param-display-name-wrong-for-dynamic-options
  displayName: "Agent",
  name: "agentKey",
  type: "options",
  required: true,
  default: "",
  description:
    'Choose from the list, or specify a key using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
  typeOptions: {
    loadOptionsMethod: "getAgentKeys",
  },
  options: [],
};

export const messageProperty: INodeProperties = {
  displayName: "Message",
  name: "message",
  type: "string",
  required: true,
  default: "",
  description: "The message to send to the agent",
  placeholder: "Enter your message...",
  typeOptions: {
    rows: 4,
  },
};

export const additionalFieldsProperty: INodeProperties = {
  displayName: "Additional Fields",
  name: "additionalFields",
  type: "collection",
  placeholder: "Add Field",
  default: {},
  options: [
    {
      displayName: "Timeout (ms)",
      name: "timeoutMs",
      type: "number",
      default: DEFAULT_RESPONSE_TIMEOUT_MS,
      description:
        "HTTP timeout in milliseconds. Agent runs can take several minutes; the default 600000 (10 min) matches server-side execution limits.",
      // UI floor is permissive so expression-provided values (e.g. from upstream
      // nodes) aren't rejected; runtime guard in OrqAgent.node.ts falls back to
      // the default when the resolved value isn't a positive number.
      typeOptions: {
        minValue: 1,
      },
    },
    {
      displayName: "Include Raw Response",
      name: "includeRawResponse",
      type: "boolean",
      default: false,
      description:
        "Whether to include the full raw API response in the node output. Off by default to keep output lean.",
    },
  ],
};

export const allProperties: INodeProperties[] = [
  agentKeyProperty,
  messageProperty,
  additionalFieldsProperty,
];
