import { readFileSync } from "node:fs";

import {
  addCliModels,
  exportCliModels,
  parseOverrides,
  setCliModels,
} from "./model-roles.js";
import { type ConfigRef, PYTHON_CONFIG_KEYS } from "./python-config-keys.js";
import { pythonJsonDumps } from "./python-json.js";

export const STDIN_SOURCE = "-";

export const MODEL_OPTION_NOTE =
  "Provider resolved from env: ORQ_API_KEY -> Orq router, else OPENAI_API_KEY " +
  "(+ OPENAI_BASE_URL) -> OpenAI-compatible endpoint. The role defaults are " +
  "provider-prefixed for the router; going OpenAI-direct means passing the bare id.";

export function examples(...lines: string[]): string {
  return ["Examples", ...lines].join("\n");
}

export class BadParameter extends Error {
  constructor(
    message: string,
    readonly paramHint: string | null = null,
  ) {
    super(message);
    this.name = "BadParameter";
  }

  render(): string {
    return this.paramHint
      ? `Error: Invalid value for ${this.paramHint}: ${this.message}`
      : `Error: Invalid value: ${this.message}`;
  }
}

export interface Flag {
  param: string;
  path: string | null;
  toValue?: (value: never) => unknown;
  replaces: readonly string[];
}

export function flag(
  param: string,
  options: {
    path?: string | null;
    toValue?: (value: never) => unknown;
    replaces?: readonly string[];
  } = {},
): Flag {
  return {
    param,
    path: options.path === undefined ? param : options.path,
    toValue: options.toValue,
    replaces: options.replaces ?? [],
  };
}

export interface ConfigModel<T> {
  name: string;
  build: (data: Record<string, unknown>) => T;
}

export function jsonFlag(
  param: string,
  path: string,
  model: ConfigModel<unknown>,
  options: { flag: string },
): Flag {
  return flag(param, {
    path,
    toValue: ((raw: string) =>
      parseJsonConfig(raw, model, { flag: options.flag })) as never,
  });
}

export function resolveConfig<T>(
  model: ConfigModel<T>,
  flags: Iterable<Flag>,
  cliArgs: Record<string, unknown>,
  options: { configSource?: string | null; readStdin?: () => string } = {},
): T {
  let data: Record<string, unknown> = {};
  if (options.configSource != null)
    data = loadConfig(options.configSource, model, {
      readStdin: options.readStdin,
    });
  const overrides: Record<string, unknown> = {};
  for (const row of flags) {
    if (cliArgs[row.param] === undefined) continue;
    for (const field of row.replaces) delete data[field];
    if (row.path === null) continue;
    const value = cliArgs[row.param];
    setPath(
      overrides,
      row.path,
      row.toValue ? row.toValue(value as never) : value,
    );
  }
  const merged = deepMerge(data, overrides);
  return validate(model, merged, "", null);
}

export function parseJsonConfig(
  raw: string,
  model: ConfigModel<unknown>,
  options: { flag: string; origin?: string | null },
): Record<string, unknown> {
  const where = options.origin ? `${options.origin}: ` : "";
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new BadParameter(
      `${where}${error instanceof Error ? error.message : String(error)}`,
      options.flag,
    );
  }
  if (data === null || typeof data !== "object" || Array.isArray(data))
    throw new BadParameter(
      `${where}expected a JSON object for ${model.name}`,
      options.flag,
    );
  validate(model, data as Record<string, unknown>, where, options.flag);
  return data as Record<string, unknown>;
}

export function loadConfig(
  source: string,
  model: ConfigModel<unknown>,
  options: { flag?: string; readStdin?: () => string } = {},
): Record<string, unknown> {
  const flagName = options.flag ?? "--config";
  if (source.trimStart().startsWith("{"))
    return parseJsonConfig(source, model, {
      flag: flagName,
      origin: "inline JSON",
    });
  let raw: string;
  let origin = source;
  if (source === STDIN_SOURCE) {
    raw = (options.readStdin ?? (() => readFileSync(0, "utf8")))();
    origin = "stdin";
  } else {
    try {
      raw = readFileSync(source, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new BadParameter(
        `cannot read ${source}: ${code === "ENOENT" ? "No such file or directory" : error instanceof Error ? error.message : String(error)}`,
        flagName,
      );
    }
  }
  return parseJsonConfig(raw, model, { flag: flagName, origin });
}

export function unknownConfigKeys(model: string, data: unknown): string[] {
  const found: string[] = [];
  walk([model], data, "", found);
  return [...new Set(found)];
}

function walk(
  refs: readonly ConfigRef[],
  value: unknown,
  path: string,
  found: string[],
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      walk(refs, item, `${path}[${index}]`, found);
    });
    return;
  }
  if (value === null || typeof value !== "object") return;
  const records = refs.filter((ref): ref is readonly ["r", ConfigRef] =>
    Array.isArray(ref),
  );
  if (records.length) {
    for (const [key, item] of Object.entries(value))
      walk(
        records.map((ref) => ref[1]),
        item,
        path ? `${path}.${key}` : key,
        found,
      );
    return;
  }
  const models = refs.filter((ref): ref is string => typeof ref === "string");
  if (!models.length) return;
  const fields = models.map((name) => PYTHON_CONFIG_KEYS[name] ?? {});
  const record = value as Record<string, unknown>;
  const known = new Set<string>();
  for (const table of fields)
    for (const [key, nested] of Object.entries(table)) {
      known.add(key);
      if (Object.hasOwn(record, key))
        walk(nested, record[key], path ? `${path}.${key}` : key, found);
    }
  for (const key of Object.keys(record))
    if (!known.has(key)) found.push(path ? `${path}.${key}` : key);
}

function validate<T>(
  model: ConfigModel<T>,
  data: Record<string, unknown>,
  where: string,
  paramHint: string | null,
): T {
  const unknown = unknownConfigKeys(model.name, data);
  if (unknown.length)
    throw new BadParameter(
      `${where}unknown key(s): ${unknown.join(", ")}. Extra inputs are not permitted.`,
      paramHint,
    );
  try {
    return model.build(data);
  } catch (error) {
    throw new BadParameter(`${where}${validationText(error)}`, paramHint);
  }
}

function validationText(error: unknown): string {
  if (
    error !== null &&
    typeof error === "object" &&
    "issues" in error &&
    Array.isArray(error.issues)
  )
    return (error.issues as { path: PropertyKey[]; message: string }[])
      .map((issue) =>
        issue.path.length
          ? `${issue.path.map(String).join(".")}: ${issue.message}`
          : issue.message,
      )
      .join("; ");
  return error instanceof Error ? error.message : String(error);
}

function setPath(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const parts = path.split(".");
  const leaf = parts.pop() as string;
  let node = target;
  for (const key of parts) {
    if (node[key] === null || typeof node[key] !== "object") node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[leaf] = value;
}

export function deepMerge(
  base: Record<string, unknown>,
  updates: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(updates)) {
    const current = merged[key];
    merged[key] =
      isPlainObject(current) && isPlainObject(value)
        ? deepMerge(current, value)
        : value;
  }
  return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function echoJson(
  value: unknown,
  print: (line: string) => void = (line) => {
    process.stdout.write(`${line}\n`);
  },
): void {
  print(pythonJsonDumps(value));
}

export function shellPath(path: string): string {
  if (process.platform === "win32")
    return /[\s"]/.test(path) ? `"${path.replace(/"/g, '\\"')}"` : path;
  if (path === "") return "''";
  return /^[\w@%+=:,./-]+$/.test(path)
    ? path
    : `'${path.replace(/'/g, "'\"'\"'")}'`;
}

export function applyModelFlags(
  flags: {
    fast?: string | null;
    smart?: string | null;
    classifier?: string | null;
    embedding?: string | null;
    overrides?: readonly string[] | null;
  },
  options: { replace?: boolean } = {},
): void {
  let parsed: Record<string, string>;
  try {
    parsed = parseOverrides(flags.overrides ?? []);
  } catch (error) {
    throw new BadParameter(
      error instanceof Error ? error.message : String(error),
      "--model-override",
    );
  }
  const roles = {
    fast: flags.fast,
    smart: flags.smart,
    classifier: flags.classifier,
    embedding: flags.embedding,
  };
  (options.replace ? setCliModels : addCliModels)(roles, parsed);
  exportCliModels();
}
