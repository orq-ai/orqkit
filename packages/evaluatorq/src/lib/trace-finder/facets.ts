import { createHash } from "node:crypto";

import type { Orq } from "@orq-ai/node";

import { getField } from "../common/fields.js";
import { pyRound } from "../common/reports/number-format.js";
import { codepointCompare, pythonString } from "../common/sanitize.js";
import {
  FACET_NAMES,
  type FacetCatalogue,
  FacetCatalogueSchema,
  type FacetName,
} from "./models.js";
import type {
  SourceClientOptions,
  SourceProjects,
  SourceRequestOptions,
} from "./orq-source.js";

export interface FacetClient {
  _options: SourceClientOptions;
  _baseURL: Orq["_baseURL"];
  traces: {
    listFacetValues: (
      request: Parameters<Orq["traces"]["listFacetValues"]>[0],
      options?: SourceRequestOptions,
    ) => Promise<unknown>;
  };
  projects: SourceProjects;
}
const FACET_FIELDS: Readonly<Record<FacetName, string>> = Object.freeze({
  project: "project_id",
  model: "model",
  provider: "provider",
  status: "status",
  product: "product",
  trace_type: "attributes.orq.leading_span.span_type",
  agent_name: "agent_name",
  tool_name: "tool_name",
});
if (
  Object.keys(FACET_FIELDS).some(
    (name) => !FACET_NAMES.includes(name as FacetName),
  )
)
  throw new Error("trace facet field mapping is out of sync with FACET_NAMES");
const CACHE_TTL = 300,
  CACHE_MAX_ENTRIES = 32,
  cache = new Map<string, { time: number; catalogue: FacetCatalogue }>(),
  inflight = new Map<
    string,
    {
      promise: Promise<FacetCatalogue>;
      controller: AbortController;
      done: boolean;
    }
  >(),
  clientIds = new WeakMap<object, number>();
let nextClientId = 0;
const read = (value: unknown, name: string): unknown =>
  getField(value, name) ??
  getField(
    value,
    name.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase()),
  );
const truth = (value: unknown): boolean =>
  value != null &&
  (Array.isArray(value)
    ? value.length > 0
    : typeof value === "object"
      ? Object.keys(value).length > 0
      : Boolean(value));
const fingerprint = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");
function date(value: Date | string): Date {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime()))
    throw new TypeError("Invalid facet time bound");
  return parsed;
}
export interface FacetLoadOptions {
  start: Date | string;
  end: Date | string;
  limit?: number;
  headers?: RequestInit["headers"];
  signal?: AbortSignal;
}
export interface CachedFacetLoadOptions extends FacetLoadOptions {
  defaultWindow?: boolean;
  now?: Date;
  loader?:
    | ((
        client: FacetClient,
        options: FacetLoadOptions,
      ) => Promise<FacetCatalogue>)
    | null;
}
async function cacheKey(
  client: FacetClient,
  options: CachedFacetLoadOptions,
): Promise<string> {
  let id = clientIds.get(client);
  if (id === undefined) {
    id = ++nextClientId;
    clientIds.set(client, id);
  }
  const configured = client._options.apiKey,
    key =
      typeof configured === "function"
        ? await configured()
        : (configured ?? ""),
    headers = [...new Headers(options.headers).entries()].sort(([a], [b]) =>
      codepointCompare(a, b),
    ),
    scope = fingerprint(JSON.stringify(headers)),
    base = client._baseURL?.href ?? client._options.serverURL ?? "";
  const start = date(options.start),
    end = date(options.end),
    window = options.defaultWindow
      ? ["rolling-default", pyRound((end.getTime() - start.getTime()) / 1000)]
      : [start.toISOString(), end.toISOString()];
  return JSON.stringify([
    id,
    base,
    fingerprint(key),
    scope,
    ...window,
    options.limit ?? 50,
  ]);
}
function clone(catalogue: FacetCatalogue): FacetCatalogue {
  return FacetCatalogueSchema.parse(catalogue);
}
export async function facetCatalogueCacheHit(
  client: FacetClient,
  options: CachedFacetLoadOptions,
): Promise<boolean> {
  const cached = cache.get(await cacheKey(client, options));
  return (
    cached !== undefined && performance.now() / 1000 - cached.time < CACHE_TTL
  );
}
function shield<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(
        signal.reason ??
          Object.assign(new Error("Aborted"), { name: "AbortError" }),
      );
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
export async function loadFacetCatalogueCached(
  client: FacetClient,
  options: CachedFacetLoadOptions,
): Promise<FacetCatalogue> {
  if (options.loader) return options.loader(client, options);
  options.signal?.throwIfAborted();
  const key = await cacheKey(client, options),
    cached = cache.get(key);
  if (cached && performance.now() / 1000 - cached.time < CACHE_TTL) {
    cache.delete(key);
    cache.set(key, cached);
    return clone(cached.catalogue);
  }
  let task = inflight.get(key);
  if (!task) {
    const controller = new AbortController();
    task = {
      controller,
      done: false,
      promise: loadFacetCatalogue(client, {
        ...options,
        signal: controller.signal,
      }),
    };
    const pending = task;
    void task.promise.then(
      () => {
        pending.done = true;
      },
      () => {
        pending.done = true;
      },
    );
    inflight.set(key, task);
  }
  let catalogue: FacetCatalogue;
  try {
    catalogue = await shield(task.promise, options.signal);
  } catch (error) {
    if (task.done && inflight.get(key) === task) inflight.delete(key);
    throw error;
  }
  if (inflight.get(key) === task) {
    inflight.delete(key);
    cache.delete(key);
    cache.set(key, {
      time: performance.now() / 1000,
      catalogue: clone(catalogue),
    });
    while (cache.size > CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }
  return clone(catalogue);
}
export async function invalidateFacetCatalogueCache(): Promise<void> {
  const tasks = [...inflight.values()];
  cache.clear();
  inflight.clear();
  for (const task of tasks) task.controller.abort();
  await Promise.allSettled(tasks.map((task) => task.promise));
}
export async function closeFacetCatalogueCache(): Promise<void> {
  await invalidateFacetCatalogueCache();
}
export function projectLabels(
  projectNames: Readonly<Record<string, string>>,
): Record<string, string> {
  const counts = new Map<string, number>();
  for (const name of Object.values(projectNames))
    counts.set(name, (counts.get(name) ?? 0) + 1);
  return Object.fromEntries(
    Object.entries(projectNames).map(([id, name]) => [
      id,
      (counts.get(name) ?? 0) > 1 ? `${name} (${id})` : name,
    ]),
  );
}
async function facetValues(
  client: FacetClient,
  field: string,
  options: FacetLoadOptions,
): Promise<
  readonly [readonly string[], boolean, Record<string, number> | null]
> {
  const response = await client.traces.listFacetValues(
      {
        field,
        from: date(options.start),
        to: date(options.end),
        limit: options.limit ?? 50,
      },
      { signal: options.signal, headers: options.headers },
    ),
    values = read(response, "values");
  if (!Array.isArray(values))
    throw new TypeError(
      `trace facet field ${field} returned no readable values`,
    );
  const ranked: { value: string; count: number; index: number }[] = [];
  let counted = true;
  for (const [index, item] of values.entries()) {
    const value = read(item, "value");
    if (typeof value !== "string" || !value || value === "unknown") continue;
    const count = read(item, "count"),
      valid =
        typeof count === "number" && Number.isInteger(count) && count >= 0;
    counted = counted && valid;
    ranked.push({ value, count: valid ? count : 0, index });
  }
  ranked.sort((a, b) => b.count - a.count || a.index - b.index);
  const counts = new Map<string, number>();
  for (const row of ranked)
    if (!counts.has(row.value)) counts.set(row.value, row.count);
  return [
    [...counts.keys()],
    truth(read(response, "has_more")),
    counted && counts.size ? Object.fromEntries(counts) : null,
  ];
}
export async function loadProjectNames(
  client: Pick<FacetClient, "projects">,
  options: FacetLoadOptions,
): Promise<Record<string, string>> {
  const projects = new Map<string, string>(),
    seen = new Set<string>();
  let cursor: string | undefined;
  while (true) {
    const response = await client.projects.list(
        { limit: 100, ...(cursor ? { startingAfter: cursor } : {}) },
        { signal: options.signal, headers: options.headers },
      ),
      page = read(response, "data"),
      items = Array.isArray(page) ? page : [];
    for (const project of items) {
      const id = read(project, "project_id"),
        name = read(project, "name");
      if (truth(id) && truth(name))
        projects.set(pythonString(id), pythonString(name));
    }
    if (!truth(read(response, "has_more"))) return Object.fromEntries(projects);
    if (!items.length)
      throw new Error("project response reported more pages without projects");
    const next = pythonString(read(items.at(-1), "project_id") || "");
    if (!next || seen.has(next))
      throw new Error(`repeated project page cursor '${next}'`);
    seen.add(next);
    cursor = next;
  }
}
export async function loadFacetCatalogue(
  client: FacetClient,
  options: FacetLoadOptions,
): Promise<FacetCatalogue> {
  options.signal?.throwIfAborted();
  const controller = new AbortController(),
    signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal,
    scoped = { ...options, signal },
    tasks = Object.values(FACET_FIELDS).map((field) =>
      facetValues(client, field, scoped),
    );
  let results: Awaited<ReturnType<typeof facetValues>>[];
  try {
    results = await Promise.all(tasks);
  } finally {
    controller.abort();
    await Promise.allSettled(tasks);
  }
  const values = Object.fromEntries(
      Object.keys(FACET_FIELDS).map((name, index) => [
        name,
        results[index]?.[0] ?? [],
      ]),
    ),
    truncatedFacets = Object.keys(FACET_FIELDS).filter(
      (_, index) => results[index]?.[1],
    ),
    valueCounts = Object.fromEntries(
      Object.keys(FACET_FIELDS).flatMap((name, index) =>
        results[index]?.[2] ? [[name, results[index]?.[2]]] : [],
      ),
    );
  if (truncatedFacets.length)
    console.warn(
      `Orq facet values exceed the ${options.limit ?? 50}-value limit for ${[...truncatedFacets].sort(codepointCompare).join(", ")}; using returned values ranked by frequency`,
    );
  const names = await loadProjectNames(client, options),
    missing = (values.project ?? []).filter((id) => !Object.hasOwn(names, id));
  if (missing.length)
    throw new Error(
      `cannot resolve facet project ids: ${JSON.stringify([...new Set(missing)].sort(codepointCompare))}`,
    );
  const labels = projectLabels(names);
  values.project = (values.project ?? []).map((id) => labels[id] as string);
  if (valueCounts.project)
    valueCounts.project = Object.fromEntries(
      Object.entries(valueCounts.project).map(([id, count]) => [
        labels[id] as string,
        count,
      ]),
    );
  return FacetCatalogueSchema.parse({
    ...values,
    truncatedFacets,
    valueCounts,
  });
}
