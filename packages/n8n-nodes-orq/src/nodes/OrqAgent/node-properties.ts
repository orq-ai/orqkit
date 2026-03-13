import type { INodeProperties } from "n8n-workflow";

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

export const allProperties: INodeProperties[] = [agentKeyProperty, messageProperty];
