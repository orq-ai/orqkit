import type { INode } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { ERROR_MESSAGES, KEY_VALIDATION_REGEX } from './constants';
import type { OrqCredentials, OrqInputMessage } from './types';

export function validateDeploymentKey(deploymentKey: string, node: INode): void {
	if (!deploymentKey || deploymentKey.trim() === '') {
		throw new NodeOperationError(node, ERROR_MESSAGES.DEPLOYMENT_KEY_REQUIRED);
	}
}

export function validateMessages(messages: OrqInputMessage[], node: INode): void {
	if (messages.length === 0) {
		throw new NodeOperationError(node, ERROR_MESSAGES.MESSAGE_REQUIRED);
	}
}

export function validateKey(
	key: string,
	type: 'context' | 'input',
	node: INode,
): void {
	if (!KEY_VALIDATION_REGEX.test(key)) {
		const errorMessage =
			type === 'context'
				? ERROR_MESSAGES.INVALID_CONTEXT_KEY(key)
				: ERROR_MESSAGES.INVALID_INPUT_KEY(key);
		throw new NodeOperationError(node, errorMessage);
	}
}

export function validateCredentials(
	credentials: unknown,
	node: INode,
): void {
	if (!credentials) {
		throw new NodeOperationError(node, ERROR_MESSAGES.NO_CREDENTIALS);
	}
	
	const creds = credentials as OrqCredentials;
	if (!creds.apiKey) {
		throw new NodeOperationError(node, 'API Key is required in credentials');
	}
}

// Export for backward compatibility if needed
export const Validators = {
	validateDeploymentKey,
	validateMessages,
	validateKey,
	validateCredentials,
};