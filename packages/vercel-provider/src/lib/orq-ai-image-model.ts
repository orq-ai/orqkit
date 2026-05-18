import type {
  ImageModelV3,
  ImageModelV3File,
  SharedV3ProviderOptions,
  SharedV3Warning,
} from "@ai-sdk/provider";
import {
  combineHeaders,
  convertBase64ToUint8Array,
  convertToFormData,
  convertUint8ArrayToBase64,
  createJsonErrorResponseHandler,
  createJsonResponseHandler,
  downloadBlob,
  type FetchFunction,
  postFormDataToApi,
  postJsonToApi,
} from "@ai-sdk/provider-utils";
import { z } from "zod/v4";

// Inline copy of `defaultOpenAICompatibleErrorStructure` from
// `@ai-sdk/openai-compatible/src/openai-compatible-error.ts`. That module
// does not re-export the value (only the type), so we replicate the schema
// here. Orq's proxy returns OpenAI-shaped error envelopes, so this matches.
const orqAiErrorDataSchema = z.object({
  error: z.object({
    message: z.string(),
    type: z.string().nullish(),
    param: z.any().nullish(),
    code: z.union([z.string(), z.number()]).nullish(),
  }),
});
type OrqAiErrorData = z.infer<typeof orqAiErrorDataSchema>;

const defaultOrqAiErrorStructure = {
  errorSchema: orqAiErrorDataSchema,
  errorToMessage: (data: OrqAiErrorData) => data.error.message,
};

export type OrqAiImageModelConfig = {
  provider: string;
  headers: () => Record<string, string | undefined>;
  url: (options: { modelId: string; path: string }) => string;
  fetch?: FetchFunction;
  _internal?: {
    currentDate?: () => Date;
  };
};

/**
 * Image model for the Orq AI proxy.
 *
 * Why this exists rather than reusing `OpenAICompatibleImageModel`:
 * - `OpenAICompatibleImageModel` hardcodes `response_format: "b64_json"` in
 *   the request body. Newer OpenAI image models (gpt-image-1+) reject the
 *   parameter with "Unknown parameter: 'response_format'" and the Orq proxy
 *   forwards that error verbatim. Omitting the field works on every
 *   upstream because they all default to returning the image inline.
 * - Different upstreams Orq routes to return the image under different
 *   shapes: OpenAI / Google return `b64_json`, while fal / Leonardo / others
 *   return a data URI under `url`. Some providers may eventually return an
 *   http(s) URL. This class accepts all three shapes and normalizes to a
 *   base64 string.
 */
export class OrqAiImageModel implements ImageModelV3 {
  readonly specificationVersion = "v3";
  readonly maxImagesPerCall = 10;

  get provider(): string {
    return this.config.provider;
  }

  private get providerOptionsKey(): string {
    // `config.provider` is always set by `createOrqAiProvider` to
    // `"orq.ai.<modelType>"`, so split[0] is "orq". Keep the optional
    // chain + fallback to satisfy the linter without changing behavior.
    return this.config.provider.split(".")[0]?.trim() ?? "orq";
  }

  constructor(
    readonly modelId: string,
    private readonly config: OrqAiImageModelConfig,
  ) {}

  /**
   * Extract user-supplied extra body fields from `providerOptions.orq`.
   *
   * These are spread into the request body AFTER `model/prompt/n/size` so
   * users can override defaults intentionally (e.g. `quality`, `style`).
   * This mirrors the upstream `OpenAICompatibleImageModel` contract.
   */
  private getArgs(
    providerOptions: SharedV3ProviderOptions,
  ): Record<string, unknown> {
    return {
      ...providerOptions[this.providerOptionsKey],
    };
  }

  async doGenerate({
    prompt,
    n,
    size,
    aspectRatio,
    seed,
    providerOptions,
    headers,
    abortSignal,
    files,
    mask,
  }: Parameters<ImageModelV3["doGenerate"]>[0]): Promise<
    Awaited<ReturnType<ImageModelV3["doGenerate"]>>
  > {
    const warnings: Array<SharedV3Warning> = [];

    if (aspectRatio != null) {
      warnings.push({
        type: "unsupported",
        feature: "aspectRatio",
        details:
          "This model does not support aspect ratio. Use `size` instead.",
      });
    }
    if (seed != null) {
      warnings.push({ type: "unsupported", feature: "seed" });
    }
    if (mask != null) {
      warnings.push({
        type: "unsupported",
        feature: "image inpainting (mask parameter)",
        details:
          "The Orq AI image-edits endpoint does not accept a `mask` field.",
      });
    }

    const currentDate = this.config._internal?.currentDate?.() ?? new Date();
    const args = this.getArgs(providerOptions);

    const failedResponseHandler = createJsonErrorResponseHandler(
      defaultOrqAiErrorStructure,
    );
    const successfulResponseHandler = createJsonResponseHandler(
      orqAiImageResponseSchema,
    );

    // Image editing branch: multipart form-data to /images/edits.
    // Orq's edit endpoint schema (see orq-node `CreateImageEditRequestBody`)
    // does not include a `mask` field, so it is dropped here even if provided.
    let response: z.infer<typeof orqAiImageResponseSchema>;
    let responseHeaders: Record<string, string> | undefined;

    if (files != null && files.length > 0) {
      const formResult = await postFormDataToApi({
        url: this.config.url({
          path: "/images/edits",
          modelId: this.modelId,
        }),
        headers: combineHeaders(this.config.headers(), headers),
        formData: convertToFormData<OrqAiFormDataInput>({
          model: this.modelId,
          prompt,
          image: await Promise.all(files.map((file) => fileToFormPart(file))),
          n,
          size,
          ...args,
        }),
        failedResponseHandler,
        successfulResponseHandler,
        abortSignal,
        fetch: this.config.fetch,
      });
      response = formResult.value;
      responseHeaders = formResult.responseHeaders;
    } else {
      const jsonResult = await postJsonToApi({
        url: this.config.url({
          path: "/images/generations",
          modelId: this.modelId,
        }),
        headers: combineHeaders(this.config.headers(), headers),
        body: {
          model: this.modelId,
          prompt,
          n,
          size,
          ...args,
        },
        failedResponseHandler,
        successfulResponseHandler,
        abortSignal,
        fetch: this.config.fetch,
      });
      response = jsonResult.value;
      responseHeaders = jsonResult.responseHeaders;
    }

    const images = await Promise.all(
      response.data.map((item) =>
        normalizeImageEntry(item, this.config.fetch ?? globalThis.fetch),
      ),
    );

    const usage = response.usage
      ? {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          totalTokens: response.usage.total_tokens,
        }
      : undefined;

    return {
      images,
      warnings,
      response: {
        timestamp: currentDate,
        modelId: this.modelId,
        headers: responseHeaders,
      },
      usage,
    };
  }
}

type OrqAiFormDataInput = {
  model: string;
  prompt: string | undefined;
  image: File | File[];
  n: number | undefined;
  size: `${number}x${number}` | undefined;
  [key: string]: unknown;
};

// Orq's `/images/edits` rejects parts with no recognizable filename
// extension (returns `unsupported_file_mimetype` for application/octet-stream).
// Wrap the payload in a `File` so the multipart part carries both a filename
// with extension AND the correct mime type.
const MEDIA_TYPE_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
};

async function fileToFormPart(file: ImageModelV3File): Promise<File> {
  if (file.type === "url") {
    const blob = await downloadBlob(file.url);
    const mediaType = blob.type || "image/png";
    const ext = MEDIA_TYPE_TO_EXT[mediaType] ?? "png";
    const buf = new Uint8Array(await blob.arrayBuffer());
    return new File([buf], `image.${ext}`, { type: mediaType });
  }
  const data =
    file.data instanceof Uint8Array
      ? file.data
      : convertBase64ToUint8Array(file.data);
  const mediaType = file.mediaType || "image/png";
  const ext = MEDIA_TYPE_TO_EXT[mediaType] ?? "png";
  return new File([data], `image.${ext}`, { type: mediaType });
}

const orqAiImageEntrySchema = z.object({
  b64_json: z.string().optional(),
  url: z.string().optional(),
  revised_prompt: z.string().optional(),
});

const orqAiUsageSchema = z
  .object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    total_tokens: z.number().optional(),
  })
  .optional();

const orqAiImageResponseSchema = z.object({
  data: z.array(orqAiImageEntrySchema),
  usage: orqAiUsageSchema,
});

const DATA_URI_RE = /^data:([^;,]+)?;base64,(.*)$/i;

async function normalizeImageEntry(
  item: z.infer<typeof orqAiImageEntrySchema>,
  fetchFn: typeof fetch,
): Promise<string> {
  if (item.b64_json) return item.b64_json;
  if (!item.url) {
    throw new Error(
      "Orq AI image response contained neither `b64_json` nor `url`.",
    );
  }
  const match = item.url.match(DATA_URI_RE);
  if (match) {
    // Data URI: strip the prefix and return the base64 payload as-is.
    return match[2] ?? "";
  }
  // http(s) URL: fetch the bytes and encode.
  const res = await fetchFn(item.url);
  if (!res.ok) {
    throw new Error(
      `Failed to download image from ${item.url}: ${res.status} ${res.statusText}`,
    );
  }
  return convertUint8ArrayToBase64(new Uint8Array(await res.arrayBuffer()));
}
