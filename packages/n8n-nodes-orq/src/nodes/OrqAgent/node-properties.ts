import type { INodeProperties } from "n8n-workflow";

import { DEFAULT_RESPONSE_TIMEOUT_SECONDS } from "./constants";

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
      displayName: "Previous Response ID",
      name: "previousResponseId",
      type: "string",
      default: "",
      description:
        "ID of a prior response to continue from. Mutually exclusive with Conversation ID.",
    },
    {
      displayName: "Conversation ID",
      name: "conversationId",
      type: "string",
      default: "",
      description:
        "ID of an existing conversation (conv_...) to thread this call into. Mutually exclusive with Previous Response ID.",
    },
    {
      displayName: "Memory Entity ID",
      name: "memoryEntityId",
      type: "string",
      default: "",
      description:
        "Attach a persistent memory entity so the agent can recall facts across calls.",
    },
    {
      displayName: "Store Response",
      name: "store",
      type: "boolean",
      default: true,
      description:
        "Whether Orq should persist this response server-side. Turn off for ephemeral calls; note that Previous Response ID continuation requires this to stay on.",
    },
    {
      displayName: "Variables",
      name: "variables",
      type: "fixedCollection",
      typeOptions: { multipleValues: true },
      default: {},
      description:
        "Template variables passed to the agent's prompt. Turn on Secret to wrap the value so it isn't logged.",
      options: [
        {
          displayName: "Variable",
          name: "variable",
          values: [
            {
              displayName: "Name",
              name: "name",
              type: "string",
              default: "",
              placeholder: "e.g. customerName",
            },
            {
              displayName: "Value",
              name: "value",
              type: "string",
              default: "",
            },
            {
              displayName: "Secret",
              name: "isSecret",
              type: "boolean",
              default: false,
              description:
                "Whether to wrap this value as a secret so Orq redacts it in logs.",
            },
          ],
        },
      ],
    },
    {
      displayName: "Metadata",
      name: "metadata",
      type: "fixedCollection",
      typeOptions: { multipleValues: true },
      default: {},
      description:
        "Key-value tags attached to this call; queryable later in the Orq dashboard. Max 16 pairs.",
      options: [
        {
          displayName: "Entry",
          name: "entry",
          values: [
            {
              displayName: "Name",
              name: "name",
              type: "string",
              default: "",
              placeholder: "e.g. workflow",
            },
            {
              displayName: "Value",
              name: "value",
              type: "string",
              default: "",
            },
          ],
        },
      ],
    },
  ],
};

export const timeoutSecondsProperty: INodeProperties = {
  displayName: "Timeout (seconds)",
  name: "timeoutSeconds",
  type: "number",
  default: DEFAULT_RESPONSE_TIMEOUT_SECONDS,
  description:
    "HTTP timeout in seconds. Agent runs can take several minutes; the default 600 (10 min) matches server-side execution limits.",
  // UI floor is permissive so expression-provided values (e.g. from upstream
  // nodes) aren't rejected; runtime guard in OrqAgent.node.ts falls back to
  // the default when the resolved value isn't a positive number.
  typeOptions: {
    minValue: 1,
  },
};

export const allProperties: INodeProperties[] = [
  agentKeyProperty,
  messageProperty,
  additionalFieldsProperty,
  timeoutSecondsProperty,
];
