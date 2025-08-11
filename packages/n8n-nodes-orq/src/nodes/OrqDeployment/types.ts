export interface OrqDeployment {
	id: string;
	created: string;
	updated: string;
	key: string;
	description: string;
	promptConfig: {
		tools: Array<{
			type: string;
			function: {
				name: string;
				parameters: {
					type: 'object';
					properties: Record<string, unknown>;
				};
			};
		}>;
		model: string;
		modelType: string;
		modelParameters: Record<string, unknown>;
		provider: string;
		messages: unknown[];
	};
	version: string;
}

export interface OrqContentItem {
	type: 'text' | 'image_url';
	text?: string;
	image_url?: {
		url: string;
		detail?: 'low' | 'high' | 'auto';
	};
}
export interface OrqInputMessage {
	role: 'user' | 'system' | 'assistant';
	content: string | OrqContentItem[];
}

export interface OrqContextProperty {
	key: string;
	value: string;
}

export interface OrqInputProperty {
	key: string;
	value: string;
}

export interface OrqMessageProperty {
	role: 'user' | 'system' | 'assistant';
	contentType?: 'text' | 'image' | 'input_audio' | 'file';
	message?: string;
	imageSource?: 'url' | 'base64';
	imageUrl?: string;
	imageData?: string;
	audioData?: string;
	audioFormat?: 'wav' | 'mp3';
	fileData?: string;
	fileName?: string;
}

export interface OrqFixedCollectionMessages {
	messageProperty: OrqMessageProperty[];
}

export interface OrqFixedCollectionInputs {
	inputProperty: OrqInputProperty[];
}

export interface OrqFixedCollectionContext {
	contextProperty: OrqContextProperty[];
}

export interface OrqRequestBody {
	key: string;
	messages: OrqInputMessage[];
	context?: Record<string, string>;
	inputs?: Record<string, string>;
}

export interface OrqMessage {
	role: string;
	content: string;
	type?: string;
}

export interface OrqChoice {
	index: number;
	finish_reason: string;
	message: OrqMessage;
}

export interface OrqChatHistoryItem {
	role: string;
	message: string;
}

export interface OrqMeta {
	api_version?: {
		version: string;
	};
	billed_units?: {
		input_tokens: number;
		output_tokens: number;
	};
	tokens?: {
		input_tokens: number;
		output_tokens: number;
	};
}

export interface OrqProviderResponse {
	response_id: string;
	text: string;
	generation_id: string;
	chat_history: OrqChatHistoryItem[];
	finish_reason: string;
	meta?: OrqMeta;
}

export interface OrqApiResponse {
	id: string;
	created: Date | string;
	object: string;
	model: string;
	provider: string;
	isFinal: boolean;
	integrationId?: string;
	finalized?: Date | string;
	systemFingerprint?: string;
	retrievals?: any[];
	providerResponse?: any;
	choices: OrqChoice[];
}

export interface OrqDeploymentListResponse {
	object: 'list';
	data: OrqDeployment[];
	hasMore: boolean;
}

export interface OrqCredentials {
	apiKey: string;
}

export interface OrqDeploymentConfig {
	id: string;
	key: string;
	name?: string;
	messages?: OrqInputMessage[];
	[key: string]: string | number | boolean | object | undefined;
}
