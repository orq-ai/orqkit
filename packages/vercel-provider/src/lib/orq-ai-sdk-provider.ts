import {
  OpenAICompatibleChatLanguageModel,
  OpenAICompatibleCompletionLanguageModel,
  OpenAICompatibleEmbeddingModel,
  OpenAICompatibleImageModel,
} from "@ai-sdk/openai-compatible";
import type {
  EmbeddingModelV3,
  ImageModelV3,
  LanguageModelV3,
  ProviderV3,
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

export interface OrqAiProvider extends ProviderV3 {
  (modelId: string): LanguageModelV3;
  languageModel(modelId: string): LanguageModelV3;
  chatModel(modelId: string): LanguageModelV3;
  completionModel(modelId: string): LanguageModelV3;
  embeddingModel(modelId: string): EmbeddingModelV3;
  /** @deprecated Use embeddingModel instead */
  textEmbeddingModel(modelId: string): EmbeddingModelV3;
  imageModel(modelId: string): ImageModelV3;
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

  const createEmbeddingModel = (modelId: string) =>
    new OpenAICompatibleEmbeddingModel(
      modelId,
      getCommonModelConfig("embedding"),
    );

  const createImageModel = (modelId: string) =>
    new OpenAICompatibleImageModel(modelId, getCommonModelConfig("image"));

  const provider = function (modelId: string) {
    if (new.target) {
      throw new Error(
        "The model factory function cannot be called with the new keyword.",
      );
    }

    return createChatModel(modelId);
  };

  (provider as unknown as { specificationVersion: "v3" }).specificationVersion =
    "v3";
  provider.languageModel = createChatModel;
  provider.completionModel = createCompletionModel;
  provider.chatModel = createChatModel;
  provider.embeddingModel = createEmbeddingModel;
  provider.textEmbeddingModel = createEmbeddingModel;
  provider.imageModel = createImageModel;

  return provider as unknown as OrqAiProvider;
}
