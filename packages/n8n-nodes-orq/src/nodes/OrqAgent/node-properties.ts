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
  timeoutSecondsProperty,
];
