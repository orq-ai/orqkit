import { createHash } from "node:crypto";

import { DEFAULT_CLASSIFIER_MODEL, type Usage } from "../contracts.js";
import { envFloat, envRaw } from "./env-config.js";
import {
  MissingLLMCredentialsError,
  orqBaseUrl,
  resolveResultsBaseUrl,
} from "./llm-client.js";

export interface ModelInfoInput {
  inputCostPer1k: number | null;
  outputCostPer1k: number | null;
  provider: string;
  supportsResponses: boolean;
  reasoningEfforts?: Iterable<string> | null;
  supportsClassify?: boolean;
  modelType?: string;
  defaultReasoningEffort?: string | null;
}

export class ModelInfo {
  readonly inputCostPer1k: number | null;
  readonly outputCostPer1k: number | null;
  readonly provider: string;
  readonly supportsResponses: boolean;
  readonly reasoningEfforts: ReadonlySet<string> | null;
  readonly supportsClassify: boolean;
  readonly modelType: string;
  readonly defaultReasoningEffort: string | null;

  constructor(input: ModelInfoInput) {
    // One rate without the other cannot price a call.
    const priced =
      input.inputCostPer1k !== null && input.outputCostPer1k !== null;
    this.inputCostPer1k = priced ? input.inputCostPer1k : null;
    this.outputCostPer1k = priced ? input.outputCostPer1k : null;
    this.provider = input.provider;
    this.supportsResponses = input.supportsResponses;
    // Null means "cannot validate"; an empty set would reject every effort.
    const efforts = new Set(input.reasoningEfforts ?? []);
    this.reasoningEfforts = efforts.size > 0 ? efforts : null;
    this.supportsClassify = input.supportsClassify ?? false;
    this.modelType = input.modelType ?? "";
    this.defaultReasoningEffort = input.defaultReasoningEffort ?? null;
  }
}

export class ModelCatalogueError extends Error {
  readonly statusCode: number | undefined;

  constructor(message: string, options: { statusCode?: number } = {}) {
    super(message);
    this.name = "ModelCatalogueError";
    this.statusCode = options.statusCode;
  }
}

type Catalogue = Map<string, ModelInfo>;
type OAuthFetch = () => Promise<unknown>;

const catalogues = new Map<string, Catalogue>();
const failedCatalogues = new Set<string>();
const overrides = new Map<string, ModelInfo>();
const fetchFailures = new Map<string, number>();
const MAX_FETCH_FAILURES = 3;
const classifyFallbackWarned = new Set<string>();
let catalogueTail: Promise<unknown> = Promise.resolve();

export const KNOWN_CLASSIFY_MODELS: ReadonlySet<string> = new Set([
  DEFAULT_CLASSIFIER_MODEL,
]);

function bareId(model: string): string {
  return model.slice(model.indexOf("/") + 1);
}

function withCatalogueLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = catalogueTail.then(fn);
  catalogueTail = run.catch(() => undefined);
  return run;
}

async function fetchCataloguePayload(
  host: string,
  apiKey: string | undefined,
  oauthFetch: OAuthFetch | undefined,
): Promise<unknown> {
  if (oauthFetch) {
    return oauthFetch();
  }
  const url = `${host}/v2/models`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(
        envFloat("EVALUATORQ_CATALOGUE_TIMEOUT_S") * 1000,
      ),
    });
  } catch (error) {
    throw new ModelCatalogueError(
      `Could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new ModelCatalogueError(`HTTP ${response.status} from ${url}`, {
      statusCode: response.status,
    });
  }
  try {
    return await response.json();
  } catch {
    throw new ModelCatalogueError(
      "Orq returned invalid JSON for the model catalogue.",
      { statusCode: response.status },
    );
  }
}

export function resetCatalogueCache(): void {
  catalogues.clear();
  failedCatalogues.clear();
  fetchFailures.clear();
  classifyFallbackWarned.clear();
  catalogueTail = Promise.resolve();
}

export function registerModel(modelId: string, info: ModelInfo): void {
  overrides.set(bareId(modelId), info);
}

export function clearModelOverrides(): void {
  overrides.clear();
}

export function getModelInfo(
  model: string,
  client?: unknown,
): Promise<ModelInfo | null> {
  return lookup(model, client);
}

type Entry = Record<string, unknown>;

const isEntry = (value: unknown): value is Entry =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function usdPrice(entry: Entry, side: string): number | null {
  const cost = entry[`${side}_cost`];
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
    return null;
  }
  // Currency is "" on most entries and "usd" on the rest, so only a stated
  // non-USD price is refused.
  const currency = String(entry[`${side}_currency`] || "");
  return currency === "" || currency === "usd" ? cost : null;
}

function reasoningEffortConfig(entry: Entry): Entry | null {
  const { parameters } = entry;
  if (!Array.isArray(parameters)) {
    return null;
  }
  for (const parameter of parameters) {
    if (isEntry(parameter) && parameter.parameter === "reasoningEffort") {
      return isEntry(parameter.config) ? parameter.config : null;
    }
  }
  return null;
}

function parseReasoningEfforts(entry: Entry): string[] | null {
  const options = reasoningEffortConfig(entry)?.options;
  if (!Array.isArray(options)) {
    return null;
  }
  return options
    .filter(isEntry)
    .map((option) => option.value)
    .filter((value): value is string => typeof value === "string");
}

function parseDefaultReasoningEffort(entry: Entry): string | null {
  const value = reasoningEffortConfig(entry)?.default;
  return typeof value === "string" && value ? value : null;
}

// The same model_id appears once per hosting provider, so the bare key keeps the
// entry whose provider is the model's developer. The qualified key lets a pinned
// id price at its own host, since hosts do not always match on price.
export function parseCatalogue(payload: unknown): Catalogue {
  if (!Array.isArray(payload)) {
    console.warn(
      `Model catalogue had unexpected shape ${typeof payload} (expected a JSON list); costs and Responses routing unavailable`,
    );
    return new Map();
  }
  const models: Catalogue = new Map();
  for (const entry of payload) {
    if (!isEntry(entry)) {
      continue;
    }
    const { model_id: modelId, provider } = entry;
    if (typeof modelId !== "string" || typeof provider !== "string") {
      continue;
    }
    const metadata = isEntry(entry.metadata) ? entry.metadata : {};
    const classifyFlag = metadata.supports_classify;
    if (
      classifyFlag !== null &&
      classifyFlag !== undefined &&
      typeof classifyFlag !== "boolean"
    ) {
      console.warn(
        `Model catalogue entry ${provider}/${modelId} has non-boolean supports_classify=${JSON.stringify(classifyFlag)}; treating it as unsupported`,
      );
    }
    const info = new ModelInfo({
      inputCostPer1k: usdPrice(entry, "input"),
      outputCostPer1k: usdPrice(entry, "output"),
      provider,
      supportsResponses: Boolean(metadata.supports_responses_api),
      reasoningEfforts: parseReasoningEfforts(entry),
      supportsClassify: classifyFlag === true,
      modelType: String(entry.model_type || ""),
      defaultReasoningEffort: parseDefaultReasoningEffort(entry),
    });
    models.set(`${provider}/${modelId}`, info);
    if (!models.has(modelId) || provider === entry.model_developer) {
      models.set(modelId, info);
    }
  }
  if (payload.length > 0 && models.size === 0) {
    console.warn(
      `Model catalogue returned ${payload.length} entries but none parsed (payload shape change?); catalogue-based endpoint qualification and local pricing are unavailable, though the built-in classify fallback still applies`,
    );
  }
  return models;
}

function oauthFetchOf(client: unknown): OAuthFetch | undefined {
  const method = (client as { getModelCatalogue?: unknown } | null | undefined)
    ?.getModelCatalogue;
  return typeof method === "function"
    ? () => (method as OAuthFetch).call(client)
    : undefined;
}

function clientApiKey(client: unknown): string | undefined {
  const key = (client as { apiKey?: unknown } | null | undefined)?.apiKey;
  return (typeof key === "string" && key) || envRaw("ORQ_API_KEY") || undefined;
}

function credentialId(
  oauthFetch: OAuthFetch | undefined,
  apiKey: string | undefined,
): string {
  if (oauthFetch) {
    return "cli-oauth";
  }
  return apiKey === undefined
    ? ""
    : createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

function recordFetchFailure(
  error: unknown,
  host: string,
  cacheKey: string,
): Catalogue {
  const failures = (fetchFailures.get(cacheKey) ?? 0) + 1;
  fetchFailures.set(cacheKey, failures);
  const giveUp = failures >= MAX_FETCH_FAILURES;
  console.warn(
    `Orq model catalogue unavailable (${error instanceof Error ? error.message : String(error)}) at ${host}/v2/models (attempt ${failures} of ${MAX_FETCH_FAILURES}); catalogue-based endpoint qualification and local pricing are unavailable ${giveUp ? "for the rest of this process" : "until a later call succeeds"} (the built-in classify fallback still applies)`,
  );
  // A transient hiccup is not cached, so it cannot degrade the whole run.
  if (!giveUp) {
    return new Map();
  }
  const empty: Catalogue = new Map();
  catalogues.set(cacheKey, empty);
  failedCatalogues.add(cacheKey);
  return empty;
}

async function loadCatalogue(
  client: unknown,
  strict = false,
): Promise<Catalogue> {
  let host: string;
  try {
    host =
      client !== null && client !== undefined
        ? resolveResultsBaseUrl(client as never)
        : orqBaseUrl();
  } catch (error) {
    if (strict) throw error;
    console.warn(
      `Orq model catalogue unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return new Map();
  }
  const oauthFetch = oauthFetchOf(client);
  const apiKey = oauthFetch ? undefined : clientApiKey(client);
  const cacheKey = JSON.stringify([host, credentialId(oauthFetch, apiKey)]);
  const cacheable = !oauthFetch;
  const cachedEntry = (): Catalogue | undefined => {
    const cached = cacheable ? catalogues.get(cacheKey) : undefined;
    return cached && (!strict || !failedCatalogues.has(cacheKey))
      ? cached
      : undefined;
  };
  const early = cachedEntry();
  if (early) {
    return early;
  }
  return withCatalogueLock(async () => {
    const cached = cachedEntry();
    if (cached) {
      return cached;
    }
    if (!oauthFetch && !apiKey) {
      if (strict) {
        throw new MissingLLMCredentialsError(
          "No Orq API key or CLI OAuth session is available for the model catalogue.",
        );
      }
      const empty: Catalogue = new Map();
      catalogues.set(cacheKey, empty);
      failedCatalogues.add(cacheKey);
      return empty;
    }
    let payload: unknown;
    try {
      payload = await fetchCataloguePayload(host, apiKey, oauthFetch);
    } catch (error) {
      if (strict) {
        throw error;
      }
      if (!cacheable) {
        console.warn(
          `Orq OAuth model catalogue unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
        return new Map();
      }
      return recordFetchFailure(error, host, cacheKey);
    }
    fetchFailures.delete(cacheKey);
    const parsed = parseCatalogue(payload);
    const malformed =
      !Array.isArray(payload) || (payload.length > 0 && parsed.size === 0);
    if (strict && malformed) {
      throw new ModelCatalogueError(
        "Orq returned an unreadable model catalogue.",
      );
    }
    if (malformed) {
      failedCatalogues.add(cacheKey);
    } else {
      failedCatalogues.delete(cacheKey);
    }
    if (cacheable) {
      catalogues.set(cacheKey, parsed);
    }
    return parsed;
  });
}

export type ModelKind = "chat" | "classify" | "embedding";

export async function modelsByProvider(
  client?: unknown,
  options: { kind?: ModelKind; strict?: boolean } = {},
): Promise<Record<string, string[]>> {
  const kind = options.kind ?? "chat";
  const catalogue = await loadCatalogue(client, options.strict ?? false);
  // Each entry sits under its bare and qualified key as one object; the
  // qualified key is the longer of the two.
  const qualified = new Map<ModelInfo, string>();
  for (const [key, info] of catalogue) {
    if (
      key.startsWith(`${info.provider}/`) &&
      key.length > (qualified.get(info) ?? "").length
    ) {
      qualified.set(info, key);
    }
  }
  const grouped = new Map<string, string[]>();
  for (const [info, key] of qualified) {
    if (kind === "classify" ? info.supportsClassify : info.modelType === kind) {
      grouped.set(info.provider, [...(grouped.get(info.provider) ?? []), key]);
    }
  }
  return Object.fromEntries(
    [...grouped]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([provider, ids]) => [provider, ids.sort()]),
  );
}

function namesRouter(modelId: string, info: ModelInfo | null): boolean {
  return modelId.startsWith("orq/") || info?.provider === "orq";
}

async function lookup(
  model: string,
  client: unknown,
): Promise<ModelInfo | null> {
  const bare = bareId(model);
  const override = overrides.get(bare);
  if (override) {
    return override;
  }
  const catalogue = await loadCatalogue(client);
  return catalogue.get(model) ?? catalogue.get(bare) ?? null;
}

export async function qualifiedModel(
  model: string,
  client?: unknown,
): Promise<string | null> {
  if (model.includes("/")) {
    return model;
  }
  const info = await lookup(model, client);
  return info?.supportsResponses ? `${info.provider}/${model}` : null;
}

export function isKnownClassifyModel(model: string): boolean {
  const override = overrides.get(bareId(model));
  return override
    ? override.supportsClassify
    : KNOWN_CLASSIFY_MODELS.has(model);
}

export async function supportsClassify(
  model: string,
  client?: unknown,
): Promise<boolean> {
  const info = await lookup(model, client);
  if (info) {
    return info.supportsClassify;
  }
  if (!KNOWN_CLASSIFY_MODELS.has(model)) {
    return false;
  }
  if (!classifyFallbackWarned.has(model)) {
    classifyFallbackWarned.add(model);
    console.warn(
      `Model catalogue has no entry for ${model}; routing it to classify from the built-in list`,
    );
  }
  return true;
}

export async function validateReasoningEffort(
  effort: string,
  model: string,
  client?: unknown,
): Promise<void> {
  const info = await lookup(model, client);
  if (!info?.reasoningEfforts) {
    const state = info
      ? "listed without a reasoningEffort parameter"
      : "absent from the Orq catalogue";
    console.warn(
      `Cannot pre-validate reasoning effort '${effort}': model ${model} is ${state}; the provider will reject an unsupported value at call time instead.`,
    );
    return;
  }
  if (!info.reasoningEfforts.has(effort)) {
    throw new Error(
      `Reasoning effort '${effort}' is not accepted by ${model}. Accepted values: ${[...info.reasoningEfforts].sort().join(", ")}.`,
    );
  }
}

// Returns usage unchanged for an aggregate: pricing one at a single model's rate
// would claim full pricing for calls this function never saw. A router's own
// catalogue rate is never used, since it is one headline rate for every model
// the router can pick.
export async function priceUsage(
  usage: Usage | null,
  model: string,
  client?: unknown,
  options: { servedModel?: string | null } = {},
): Promise<Usage | null> {
  if (usage === null || usage.totalCost !== null || usage.calls > 1) {
    return usage;
  }
  const { servedModel } = options;
  const served =
    servedModel && bareId(servedModel) !== bareId(model) ? servedModel : null;
  const servedInfo = served === null ? null : await lookup(served, client);
  const servedIsRouter = served !== null && namesRouter(served, servedInfo);
  let info: ModelInfo | null;
  if (servedInfo && !servedIsRouter && servedInfo.inputCostPer1k !== null) {
    info = servedInfo;
  } else {
    info = await lookup(model, client);
    if (namesRouter(model, info) && !overrides.has(bareId(model))) {
      let reason = "did not report which model served it";
      if (served !== null && !servedIsRouter) {
        reason = `was served by ${served}, which the Orq catalogue does not price`;
      } else if (servedModel) {
        reason = `answered under router id ${servedModel}, not the model that served it`;
      }
      console.warn(
        `Router ${model} ${reason}; call stays unpriced rather than billed at the router headline rate`,
      );
      return usage;
    }
  }
  if (info?.inputCostPer1k == null || info.outputCostPer1k == null) {
    return usage;
  }
  const inputCost = (usage.inputTokens / 1000) * info.inputCostPer1k;
  const outputCost = (usage.outputTokens / 1000) * info.outputCostPer1k;
  return {
    ...usage,
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
    pricedCalls: usage.calls,
  };
}
