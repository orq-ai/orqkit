import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod/v4";

import { DEFAULT_ORQ_BASE_URL, envText } from "../common/env-config.js";
import { withFileLock } from "../common/file-lock.js";
import { TASKS } from "../common/model-role-definitions.js";
import { writePrivateAtomic } from "../common/private-files.js";
import { pythonJsonDumps } from "../common/python-json.js";
import { pythonStrip } from "../common/sanitize.js";
import { decryptApiKey, encryptApiKey } from "./secure-credentials.js";

export const SETTINGS_PATH_ENV = "EVALUATORQ_DASHBOARD_SETTINGS",
  MIN_WINDOW_DAYS = 1,
  MAX_WINDOW_DAYS = 90,
  MIN_LIMIT = 1,
  MAX_LIMIT = 5000,
  DEFAULT_LIMIT = 500,
  MIN_PARALLELISM = 1,
  MAX_PARALLELISM = 200,
  MIN_TRACE_INPUT_CHARS = 4096,
  MAX_TRACE_INPUT_CHARS = 5_000_000,
  DEFAULT_TRACE_INPUT_CHARS = 500_000,
  CURRENT_SETTINGS_SCHEMA_VERSION = 1;
export const AUTH_SETTINGS_FIELDS: ReadonlySet<string> = new Set([
  "orqAuthMethod",
  "orqApiKeyCiphertext",
  "orqOauthServer",
  "orqProfile",
  "orqProfileHost",
  "orqCredentialFingerprint",
  "orqWorkspace",
  "orqProjectId",
  "orqProjectName",
]);
export const EXPLORER_COLUMN_KEYS: ReadonlySet<string> = new Set([
  "started",
  "status",
  "trace",
  "error_message",
  "name",
  "agent",
  "model",
  "tokens_in",
  "tokens_out",
  "cache_pct",
  "cost",
  "duration",
  "provider",
  "product",
  "operation",
  "reasoning_tokens",
  "cache_write_tokens",
  "session",
  "thread",
  "trace_id",
  "match",
]);
type Row = Record<string, unknown>;
const record = (value: unknown): value is Row =>
  value != null && typeof value === "object" && !Array.isArray(value);
const own = (value: Row, key: string) => Object.hasOwn(value, key);
const snake = (key: string) =>
  key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
function integer(value: unknown): unknown {
  if (typeof value === "boolean") return Number(value);
  if (
    typeof value === "string" &&
    /^[+-]?\d(?:_?\d)*(?:\.0+)?$/.test(pythonStrip(value))
  )
    return Number(pythonStrip(value).replaceAll("_", ""));
  return value;
}
const int = (minimum: number, maximum: number) =>
  z.preprocess(integer, z.number().int().min(minimum).max(maximum));
const blank = (value: unknown): unknown =>
  typeof value === "string" ? pythonStrip(value) || null : value;
const selector = z.preprocess(blank, z.string().nullable()).default(null);
const bool = z.preprocess((value) => {
  if (value === 0 || value === 1) return Boolean(value);
  if (typeof value !== "string") return value;
  const normalized = pythonStrip(value).toLowerCase();
  if (["true", "t", "yes", "y", "on", "1"].includes(normalized)) return true;
  if (["false", "f", "no", "n", "off", "0"].includes(normalized)) return false;
  return value;
}, z.boolean());
const Shape = z.strictObject({
  schemaVersion: z
    .number()
    .int()
    .positive()
    .default(CURRENT_SETTINGS_SCHEMA_VERSION),
  fastModel: selector,
  smartModel: selector,
  classifierModel: selector,
  embeddingModel: selector,
  modelOverrides: z
    .record(z.string(), z.string())
    .default({})
    .transform((values) => {
      const kept: Record<string, string> = {};
      for (const [task, model] of Object.entries(values)) {
        if (!own(TASKS, task))
          console.warn(
            `Dropping model override for unknown task '${task}' from dashboard settings`,
          );
        else if (pythonStrip(model)) kept[task] = pythonStrip(model);
        else
          console.warn(
            `Dropping blank model override for task '${task}' from dashboard settings`,
          );
      }
      return kept;
    }),
  windowDays: int(MIN_WINDOW_DAYS, MAX_WINDOW_DAYS).default(7),
  limit: int(MIN_LIMIT, MAX_LIMIT).default(DEFAULT_LIMIT),
  parallelism: int(MIN_PARALLELISM, MAX_PARALLELISM).default(100),
  traceInputChars: int(MIN_TRACE_INPUT_CHARS, MAX_TRACE_INPUT_CHARS).default(
    DEFAULT_TRACE_INPUT_CHARS,
  ),
  filterSelection: z.enum(["llm", "llm+jev"]).default("llm+jev"),
  askAiMode: z.enum(["immediate", "review"]).default("immediate"),
  orqAuthMethod: z
    .enum(["environment", "cli_profile", "cli_oauth", "stored_api_key"])
    .default("environment"),
  orqApiKeyCiphertext: z.string().nullable().default(null),
  orqOauthServer: selector,
  orqProfile: selector,
  orqProfileHost: selector,
  orqCredentialFingerprint: selector,
  orqWorkspace: selector,
  orqProjectId: selector,
  orqProjectName: selector,
  explorerColumns: z
    .array(z.string())
    .nullable()
    .default(null)
    .transform((values) => {
      if (values == null) return null;
      const unknown = values.filter((key) => !EXPLORER_COLUMN_KEYS.has(key));
      if (unknown.length)
        console.warn(
          `Dropping unknown explorer column(s) ${unknown.join(", ")} from dashboard settings`,
        );
      return values.filter((key) => EXPLORER_COLUMN_KEYS.has(key));
    }),
  compressionInspectorEnabled: bool.default(false),
});
export type DashboardSettingsValues = z.infer<typeof Shape>;
export type DashboardSettingsInput = z.input<typeof Shape>;
const KEYS = Object.keys(Shape.shape),
  KNOWN = new Set(KEYS),
  LEGACY_KEYS = ["compilerModel", "applyModel", "classifierModel"];
function canonical(value: unknown): unknown {
  if (!record(value)) return value;
  const out = { ...value };
  for (const key of [...KEYS, ...LEGACY_KEYS]) {
    const old = snake(key);
    if (!own(out, key) && own(out, old)) out[key] = out[old];
    if (old !== key) delete out[old];
  }
  return out;
}
function migrateAuth(value: unknown): unknown {
  return record(value) && !own(value, "orqAuthMethod") && value.orqProfile
    ? { ...value, orqAuthMethod: "cli_profile" }
    : value;
}
function migrateModels(value: unknown, preserveInvalid: boolean): unknown {
  if (!record(value) || !LEGACY_KEYS.some((key) => own(value, key)))
    return value;
  const out = { ...value },
    raw = out.modelOverrides;
  if (preserveInvalid && own(out, "modelOverrides") && !record(raw)) return out;
  const overrides: Row = record(raw) ? { ...raw } : {};
  for (const [key, task] of [
    ["compilerModel", "finder.compiler"],
    ["applyModel", "apply"],
  ] as const) {
    if (!own(out, key)) continue;
    const old = out[key];
    if (preserveInvalid && typeof old !== "string") continue;
    delete out[key];
    if (
      typeof old === "string" &&
      pythonStrip(old) &&
      pythonStrip(old) !== "openai/gpt-5.6-luna"
    ) {
      const current = overrides[task];
      if (!(typeof current === "string" && pythonStrip(current)))
        overrides[task] = pythonStrip(old);
    }
  }
  if (Object.keys(overrides).length) out.modelOverrides = overrides;
  if (
    typeof out.classifierModel === "string" &&
    pythonStrip(out.classifierModel) === "typesafe/jev-latest"
  )
    out.classifierModel = null;
  return out;
}
const prepared = (value: unknown) =>
  migrateAuth(migrateModels(canonical(value), false));
export const DashboardSettingsSchema = z.preprocess(prepared, Shape);
interface SettingsState {
  futureFields: Row;
  sourceDocument: Row | null;
  baselineValues: DashboardSettingsValues | null;
  explicitUpdates: Set<string>;
  fieldsSet: Set<string>;
}
const states = new WeakMap<DashboardSettings, SettingsState>();
const state = (settings: DashboardSettings): SettingsState => {
  const value = states.get(settings);
  if (!value) throw new TypeError("Expected DashboardSettings instance");
  return value;
};
export class DashboardSettings {
  declare schemaVersion: number;
  declare fastModel: string | null;
  declare smartModel: string | null;
  declare classifierModel: string | null;
  declare embeddingModel: string | null;
  declare modelOverrides: Record<string, string>;
  declare windowDays: number;
  declare limit: number;
  declare parallelism: number;
  declare traceInputChars: number;
  declare filterSelection: "llm" | "llm+jev";
  declare askAiMode: "immediate" | "review";
  declare orqAuthMethod:
    | "environment"
    | "cli_profile"
    | "cli_oauth"
    | "stored_api_key";
  declare orqApiKeyCiphertext: string | null;
  declare orqOauthServer: string | null;
  declare orqProfile: string | null;
  declare orqProfileHost: string | null;
  declare orqCredentialFingerprint: string | null;
  declare orqWorkspace: string | null;
  declare orqProjectId: string | null;
  declare orqProjectName: string | null;
  declare explorerColumns: string[] | null;
  declare compressionInspectorEnabled: boolean;
  constructor(input: unknown = {}) {
    const raw = prepared(input);
    Object.assign(this, Shape.parse(raw));
    states.set(this, {
      futureFields: {},
      sourceDocument: null,
      baselineValues: null,
      explicitUpdates: new Set(),
      fieldsSet: new Set(record(raw) ? Object.keys(raw) : []),
    });
  }
  withUpdates(
    updates: Partial<DashboardSettingsInput> | Row,
    options: { persistent?: boolean } = {},
  ): DashboardSettings {
    const mapped = canonical(updates) as Row,
      updated = new DashboardSettings({ ...this.toJSON(), ...mapped }),
      prior = state(this),
      next = state(updated);
    next.futureFields = { ...prior.futureFields };
    next.sourceDocument = prior.sourceDocument;
    next.baselineValues = structuredClone(
      prior.baselineValues ?? this.toJSON(),
    );
    next.explicitUpdates = new Set(prior.explicitUpdates);
    if (options.persistent !== false) {
      for (const key of Object.keys(mapped)) next.explicitUpdates.add(key);
      if (prior.sourceDocument == null && prior.baselineValues == null)
        for (const key of prior.fieldsSet) next.explicitUpdates.add(key);
    } else {
      next.baselineValues = structuredClone(updated.toJSON());
      next.explicitUpdates.clear();
    }
    return updated;
  }
  toJSON(): DashboardSettingsValues {
    return Object.fromEntries(
      KEYS.map((key) => [key, (this as unknown as Row)[key]]),
    ) as DashboardSettingsValues;
  }
}
export function dashboardSettingsPath(): string {
  return envText(SETTINGS_PATH_ENV) || ".evaluatorq/dashboard-settings.json";
}
export function credentialFingerprint(
  apiKey: string | null | undefined,
  baseUrl?: string | null,
): string | null {
  if (!apiKey) return null;
  return createHash("sha256")
    .update(
      `${apiKey}\0${(baseUrl || DEFAULT_ORQ_BASE_URL).replace(/\/+$/, "")}`,
    )
    .digest("hex");
}
export function migrateSettingsV0ToV1(data: Row): Row {
  const migrated = migrateAuth(
    migrateModels({ ...(canonical(data) as Row), schemaVersion: 1 }, true),
  );
  return record(migrated) ? migrated : { ...data, schemaVersion: 1 };
}
const failures = (error: z.ZodError): string =>
  error.issues
    .map((issue) => `${issue.path.join(".")}:${issue.code}`)
    .join(", ");
export function parseDashboardSettingsDocument(
  decoded: unknown,
  path = "<settings>",
): DashboardSettings {
  let futureVersion: number | null = null,
    futureFields: Row = {},
    sourceDocument: Row | null = null;
  try {
    if (!record(decoded)) return new DashboardSettings(decoded);
    let raw = canonical(decoded) as Row;
    sourceDocument = { ...raw };
    let version = raw.schemaVersion ?? 0;
    if (
      typeof version !== "number" ||
      !Number.isInteger(version) ||
      (version <= 0 && own(raw, "schemaVersion"))
    )
      return new DashboardSettings({ ...raw, schemaVersion: version });
    if (version === 0) {
      raw = migrateSettingsV0ToV1(raw);
      version = 1;
    } else if (version > CURRENT_SETTINGS_SCHEMA_VERSION) {
      futureVersion = version;
      console.warn(
        `Dashboard settings schema version ${version} is newer than supported version ${CURRENT_SETTINGS_SCHEMA_VERSION}; reading known fields and preserving unknown top-level fields for save`,
      );
    }
    const unknown = Object.keys(raw).filter((key) => !KNOWN.has(key));
    futureFields = Object.fromEntries(unknown.map((key) => [key, raw[key]]));
    if (unknown.length) {
      console.warn(
        `Unknown dashboard settings field(s) preserved for save: ${unknown.sort().join(", ")}`,
      );
      raw = Object.fromEntries(
        Object.entries(raw).filter(([key]) => KNOWN.has(key)),
      );
    }
    let result = DashboardSettingsSchema.safeParse(raw);
    if (!result.success) {
      const defaults = new DashboardSettings().toJSON() as Row,
        recovered = { ...raw },
        seen = new Set<string>();
      while (!result.success) {
        const invalid = new Set(
          result.error.issues.map((issue) => String(issue.path[0] ?? "")),
        );
        if (
          !invalid.size ||
          invalid.has("") ||
          [...invalid].some((key) => AUTH_SETTINGS_FIELDS.has(key))
        )
          throw result.error;
        let changed = false;
        for (const key of invalid) {
          if (seen.has(key)) throw result.error;
          seen.add(key);
          if (own(defaults, key)) recovered[key] = defaults[key];
          else delete recovered[key];
          changed = true;
        }
        if (!changed) throw result.error;
        result = DashboardSettingsSchema.safeParse(recovered);
      }
      console.warn(
        `Invalid dashboard settings field(s); using defaults for ${[...seen].sort().join(", ")}`,
      );
    }
    const settings = new DashboardSettings(result.data),
      metadata = state(settings);
    metadata.futureFields = futureFields;
    metadata.sourceDocument = sourceDocument;
    metadata.baselineValues = structuredClone(settings.toJSON());
    return settings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return new DashboardSettings();
    console.warn(
      `Could not load dashboard settings from ${path} (${error instanceof z.ZodError ? failures(error) : error instanceof Error ? error.name : "error"}); using defaults`,
    );
    const settings = new DashboardSettings(),
      metadata = state(settings);
    if (error instanceof z.ZodError) {
      if (futureVersion != null) {
        settings.schemaVersion = futureVersion;
        metadata.futureFields = futureFields;
      }
      if (sourceDocument) {
        metadata.sourceDocument = sourceDocument;
        metadata.baselineValues = structuredClone(settings.toJSON());
      }
    }
    return settings;
  }
}
export async function loadDashboardSettings(
  path = dashboardSettingsPath(),
): Promise<DashboardSettings> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      console.warn(
        `Could not load dashboard settings from ${path} (${error instanceof Error ? error.name : "error"}); using defaults`,
      );
    return new DashboardSettings();
  }
  return parseDashboardSettingsDocument(decoded, path);
}

function patchModelOverrides(
  rawValue: unknown,
  previousValue: unknown,
  updatedValue: unknown,
): Row {
  const raw = record(rawValue) ? rawValue : {},
    previous = record(previousValue) ? previousValue : {},
    updated = record(updatedValue) ? updatedValue : {},
    nested = { ...raw };
  for (const key of new Set([
    ...Object.keys(previous),
    ...Object.keys(updated),
  ]))
    if (!isDeepStrictEqual(previous[key] ?? null, updated[key] ?? null)) {
      if (own(updated, key)) nested[key] = updated[key];
      else delete nested[key];
    }
  return nested;
}
function pythonSettingsDocument(persisted: Row): Row {
  const known = new Set([...KEYS, ...LEGACY_KEYS]);
  return Object.fromEntries(
    Object.entries(persisted).map(([key, value]) => [
      known.has(key) ? snake(key) : key,
      value,
    ]),
  );
}
export async function saveDashboardSettings(
  settings: DashboardSettings,
  path = dashboardSettingsPath(),
  options: { changedFields?: ReadonlySet<string> } = {},
): Promise<void> {
  await withFileLock(
    join(dirname(path), `.${basename(path)}.lock`),
    async () => {
      const values = new DashboardSettings(settings.toJSON()).toJSON() as Row,
        metadata = state(settings),
        fields = new Set(options.changedFields ?? metadata.explicitUpdates),
        defaults = new DashboardSettings().toJSON() as Row;
      if (options.changedFields == null) {
        const baseline = metadata.baselineValues ?? defaults;
        for (const [key, value] of Object.entries(values))
          if (
            !isDeepStrictEqual(
              own(baseline as Row, key) ? (baseline as Row)[key] : value,
              value,
            )
          )
            fields.add(key);
        if (metadata.sourceDocument == null && metadata.baselineValues == null)
          for (const key of metadata.fieldsSet) fields.add(key);
      }
      const unknown = [...fields].filter((key) => !KNOWN.has(key));
      if (unknown.length)
        throw new RangeError(
          `Unknown dashboard settings field(s): ${unknown.sort().join(", ")}`,
        );
      let exists = true;
      try {
        await stat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") exists = false;
        else throw error;
      }
      let persisted: Row;
      if (!exists) {
        persisted = { ...(metadata.sourceDocument ?? metadata.futureFields) };
        if (
          Object.keys(persisted).length &&
          (persisted.schemaVersion ?? 0) === 0
        )
          persisted = migrateSettingsV0ToV1(persisted);
        if (metadata.sourceDocument == null) Object.assign(persisted, defaults);
        if (fields.has("modelOverrides") && metadata.sourceDocument != null) {
          persisted.modelOverrides = patchModelOverrides(
            persisted.modelOverrides,
            metadata.baselineValues?.modelOverrides ?? defaults.modelOverrides,
            values.modelOverrides,
          );
          fields.delete("modelOverrides");
        }
        for (const field of fields)
          if (metadata.sourceDocument == null || field !== "schemaVersion")
            persisted[field] = values[field];
        if (metadata.sourceDocument != null && !own(persisted, "schemaVersion"))
          persisted.schemaVersion = values.schemaVersion;
      } else {
        const decoded: unknown = JSON.parse(await readFile(path, "utf8"));
        if (!record(decoded))
          throw new TypeError(
            `Cannot update dashboard settings at ${path}: expected a JSON object`,
          );
        let latest = canonical(decoded) as Row;
        const version = latest.schemaVersion ?? 0;
        if (
          typeof version !== "number" ||
          !Number.isInteger(version) ||
          version < 0 ||
          (version === 0 && own(latest, "schemaVersion"))
        )
          throw new RangeError(
            `Cannot update dashboard settings at ${path}: invalid schemaVersion`,
          );
        if (fields.has("schemaVersion")) {
          if (values.schemaVersion !== version)
            throw new RangeError(
              "schemaVersion can only change through a supported migration",
            );
          fields.delete("schemaVersion");
        }
        if (version === 0) latest = migrateSettingsV0ToV1(latest);
        if (fields.has("modelOverrides")) {
          latest.modelOverrides = patchModelOverrides(
            latest.modelOverrides,
            metadata.baselineValues?.modelOverrides ?? defaults.modelOverrides,
            values.modelOverrides,
          );
          fields.delete("modelOverrides");
        }
        for (const field of fields) latest[field] = values[field];
        persisted = latest;
      }
      if ([...fields].some((key) => AUTH_SETTINGS_FIELDS.has(key)))
        new DashboardSettings(
          Object.fromEntries(
            [...AUTH_SETTINGS_FIELDS]
              .filter((field) => own(persisted, field))
              .map((field) => [field, persisted[field]]),
          ),
        );
      await writePrivateAtomic(
        path,
        `${pythonJsonDumps(pythonSettingsDocument(persisted))}\n`,
        { privateDirectory: false },
      );
    },
  );
}
export async function effectiveDashboardSettings(
  overrides: Row = {},
  path = dashboardSettingsPath(),
): Promise<DashboardSettings> {
  const saved = await loadDashboardSettings(path),
    values = saved.toJSON();
  if (values.orqAuthMethod !== "cli_oauth") {
    values.orqWorkspace = null;
    values.orqProjectId = null;
    values.orqProjectName = null;
  }
  for (const [field, name, min, max] of [
    [
      "windowDays",
      "EVALUATORQ_FINDER_WINDOW_DAYS",
      MIN_WINDOW_DAYS,
      MAX_WINDOW_DAYS,
    ],
    ["limit", "EVALUATORQ_FINDER_LIMIT", MIN_LIMIT, MAX_LIMIT],
    [
      "parallelism",
      "EVALUATORQ_FINDER_PARALLELISM",
      MIN_PARALLELISM,
      MAX_PARALLELISM,
    ],
  ] as const) {
    const value = envText(name);
    if (!value) continue;
    const parsed = /^[+-]?\d(?:_?\d)*$/.test(value)
      ? Number(value.replaceAll("_", ""))
      : NaN;
    if (!Number.isInteger(parsed)) {
      console.warn(`Ignoring invalid integer ${name} in finder settings`);
      continue;
    }
    if (parsed < min || parsed > max) {
      console.warn(
        `Ignoring out-of-range ${name} in finder settings; expected ${min}..${max}`,
      );
      continue;
    }
    values[field] = parsed;
  }
  const mapped = canonical(overrides) as Row;
  return saved.withUpdates(
    {
      ...values,
      ...Object.fromEntries(
        Object.entries(mapped).filter(([, value]) => value != null),
      ),
    },
    { persistent: false },
  );
}
export async function storeDashboardApiKey(
  settings: DashboardSettings,
  key: string,
): Promise<DashboardSettings> {
  const normalized = pythonStrip(key);
  if (!normalized) throw new RangeError("API key must not be blank");
  return settings.withUpdates({
    orqAuthMethod: "stored_api_key",
    orqApiKeyCiphertext: await encryptApiKey(normalized),
  });
}
export async function readStoredDashboardApiKey(
  settings: DashboardSettings,
): Promise<string | null> {
  return settings.orqApiKeyCiphertext
    ? decryptApiKey(settings.orqApiKeyCiphertext)
    : null;
}
