import {
  OpenAICompatibleChatLanguageModel,
  OpenAICompatibleCompletionLanguageModel,
  OpenAICompatibleEmbeddingModel,
  OpenAICompatibleImageModel,
} from "@ai-sdk/openai-compatible";
import type {
  EmbeddingModelV2,
  ImageModelV2,
  LanguageModelV2,
} from "@ai-sdk/provider";
import {
  type FetchFunction,
  withoutTrailingSlash,
} from "@ai-sdk/provider-utils";

const DEFAULT_BASE_URL = "https://api.orq.ai/v2/proxy";

export interface OrqAiProviderSettings {
  apiKey: string;
  baseURL?: string;
  headers?: Record<string, string>;
}

export interface OrqAiProvider {
  (modelId: string): LanguageModelV2;
  chatModel(modelId: string): LanguageModelV2;
  completionModel(modelId: string): LanguageModelV2;
  textEmbeddingModel(modelId: string): EmbeddingModelV2<string>;
  imageModel(modelId: string): ImageModelV2;
}

export function createOrqAiProvider(
  options: OrqAiProviderSettings,
): OrqAiProvider {
  const baseURL = withoutTrailingSlash(options.baseURL ?? DEFAULT_BASE_URL);
  const getHeaders = () => ({
    ...options.headers,
    Authorization: `Bearer ${options.apiKey}`,
  });

  interface CommonModelConfig {
    provider: string;
    url: ({ path }: { path: string }) => string;
    headers: () => Record<string, string>;
    fetch?: FetchFunction;
  }

  const getCommonModelConfig = (modelType: string): CommonModelConfig => ({
    provider: `orq.ai.${modelType}`,
    url: ({ path }) => {
      const url = new URL(`${baseURL}${path}`);
      return url.toString();
    },
    headers: getHeaders,
  });

  const createChatModel = (modelId: string) => {
    return new OpenAICompatibleChatLanguageModel(
      modelId,
      getCommonModelConfig("chat"),
    );
  };

  const createCompletionModel = (modelId: string) =>
    new OpenAICompatibleCompletionLanguageModel(
      modelId,
      getCommonModelConfig("completion"),
    );

  const createTextEmbeddingModel = (modelId: string) =>
    new OpenAICompatibleEmbeddingModel(
      modelId,
      getCommonModelConfig("embedding"),
    );

  const createImageModel = (modelId: string) =>
    new OpenAICompatibleImageModel(modelId, getCommonModelConfig("image"));

  const provider = (modelId: string) => createChatModel(modelId);

  provider.completionModel = createCompletionModel;
  provider.chatModel = createChatModel;
  provider.textEmbeddingModel = createTextEmbeddingModel;
  provider.imageModel = createImageModel;

  return provider;
}
