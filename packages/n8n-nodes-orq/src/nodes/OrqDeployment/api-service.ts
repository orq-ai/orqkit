import type {
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodePropertyOptions,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import {
	DEFAULT_BASE_URL,
	DEPLOYMENT_INVOKE_ENDPOINT,
	DEPLOYMENTS_LIST_ENDPOINT,
	ERROR_MESSAGES,
} from './constants';
import type {
	OrqApiResponse,
	OrqDeployment,
	OrqDeploymentListResponse,
	OrqRequestBody,
} from './types';

export async function getDeploymentKeys(
	context: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	const baseUrl = DEFAULT_BASE_URL;

	try {
		const response = (await context.helpers.requestWithAuthentication.call(
			context,
			'orqApi',
			{
				method: 'GET',
				url: `${baseUrl}${DEPLOYMENTS_LIST_ENDPOINT}?limit=50`,
				json: true,
			},
		)) as OrqDeploymentListResponse;

		const deployments = (response.data || response) as OrqDeployment[];

		return deployments.map((deployment: OrqDeployment) => ({
			name: deployment.key,
			value: deployment.key,
		}));
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : 'Unknown error';
		throw new NodeOperationError(
			context.getNode(),
			ERROR_MESSAGES.FETCH_DEPLOYMENTS_FAILED(errorMessage),
		);
	}
}

export async function invokeDeployment(
	context: IExecuteFunctions,
	body: OrqRequestBody,
): Promise<OrqApiResponse> {
	const baseUrl = DEFAULT_BASE_URL;

	return await context.helpers.requestWithAuthentication.call(
		context,
		'orqApi',
		{
			method: 'POST',
			url: `${baseUrl}${DEPLOYMENT_INVOKE_ENDPOINT}`,
			body,
			json: true,
		},
	);
}