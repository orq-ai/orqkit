import { parseDashboardSettingsDocument } from "../trace-finder/settings.js";
import { ROLES, type Role, TASKS } from "./model-role-definitions.js";

export type { Role } from "./model-role-definitions.js";
export { ROLES, TASKS } from "./model-role-definitions.js";

import { readFileSync } from "node:fs";

import {
  DEFAULT_CLASSIFIER_MODEL,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_FAST_MODEL,
  DEFAULT_SMART_MODEL,
} from "../contracts.js";
import { envText } from "./env-config.js";

const BUILTIN: Record<Role, string> = {
  fast: DEFAULT_FAST_MODEL,
  smart: DEFAULT_SMART_MODEL,
  classifier: DEFAULT_CLASSIFIER_MODEL,
  embedding: DEFAULT_EMBEDDING_MODEL,
};

const ROLE_ENV: Record<Role, string> = {
  fast: "EVALUATORQ_FAST_MODEL",
  smart: "EVALUATORQ_SMART_MODEL",
  classifier: "EVALUATORQ_CLASSIFIER_MODEL",
  embedding: "EVALUATORQ_EMBEDDING_MODEL",
};

const LEGACY_TASK_ENV: Readonly<Record<string, string>> = {
  "finder.compiler": "EVALUATORQ_COMPILER_MODEL",
  apply: "EVALUATORQ_APPLY_MODEL",
};

export const OVERRIDES_ENV = "EVALUATORQ_MODEL_OVERRIDES";

let cliRoles: Partial<Record<Role, string>> = {};
let cliOverrides: Record<string, string> = {};
const warnedLegacy = new Set<string>();

type RoleFlags = Partial<Record<Role, string | null | undefined>>;

export function addCliModels(
  roles?: RoleFlags | null,
  overrides?: Readonly<Record<string, string>> | null,
): void {
  for (const [role, model] of Object.entries(roles ?? {})) {
    if (model?.trim()) {
      cliRoles[role as Role] = model.trim();
    }
  }
  Object.assign(cliOverrides, overrides ?? {});
}

export function setCliModels(
  roles?: RoleFlags | null,
  overrides?: Readonly<Record<string, string>> | null,
): void {
  cliRoles = {};
  cliOverrides = {};
  addCliModels(roles, overrides);
}

export function parseOverrides(
  pairs: Iterable<string>,
): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    const task = (at === -1 ? pair : pair.slice(0, at)).trim();
    const model = at === -1 ? "" : pair.slice(at + 1).trim();
    if (at === -1 || !task || !model) {
      throw new Error(`expected task=model, got '${pair}'`);
    }
    if (!Object.hasOwn(TASKS, task)) {
      throw new Error(
        `unknown task '${task}'; valid tasks: ${Object.keys(TASKS).join(", ")}`,
      );
    }
    parsed[task] = model;
  }
  return parsed;
}

const hasCliModels = () =>
  Object.keys(cliRoles).length > 0 || Object.keys(cliOverrides).length > 0;

export function exportCliModels(): void {
  if (hasCliModels()) {
    process.env[OVERRIDES_ENV] = JSON.stringify({
      roles: cliRoles,
      overrides: cliOverrides,
    });
  } else {
    delete process.env[OVERRIDES_ENV];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inheritedCliModels(): {
  roles: Record<string, string>;
  overrides: Record<string, string>;
} {
  const raw = process.env[OVERRIDES_ENV]?.trim();
  if (!raw) {
    return { roles: {}, overrides: {} };
  }
  let loaded: unknown;
  try {
    loaded = JSON.parse(raw);
  } catch {
    loaded = undefined;
  }
  if (!isRecord(loaded)) {
    console.warn(`Ignoring malformed ${OVERRIDES_ENV}`);
    return { roles: {}, overrides: {} };
  }
  const data = loaded;
  const pick = (key: string, valid: readonly string[]) => {
    const found = isRecord(data[key]) ? data[key] : {};
    const good = Object.fromEntries(
      Object.entries(found).flatMap(([k, v]) =>
        valid.includes(k) && typeof v === "string" && v.trim()
          ? [[k, v.trim()]]
          : [],
      ),
    );
    if (Object.keys(good).length !== Object.keys(found).length) {
      console.warn(`Ignoring unknown or blank ${key} in ${OVERRIDES_ENV}`);
    }
    return good;
  };
  return {
    roles: pick("roles", ROLES),
    overrides: pick("overrides", Object.keys(TASKS)),
  };
}

function legacyEnv(task: string): string | undefined {
  const name = LEGACY_TASK_ENV[task];
  if (!name) {
    return undefined;
  }
  const value = envText(name);
  if (value && !warnedLegacy.has(name)) {
    warnedLegacy.add(name);
    console.warn(
      `${name} is deprecated; use --model-override ${task}=${value} or the settings file`,
    );
  }
  return value;
}

export interface ModelSettings {
  roles: Partial<Record<Role, string>>;
  modelOverrides: Record<string, string>;
}

const NO_SETTINGS = (): ModelSettings => ({ roles: {}, modelOverrides: {} });

export function settingsPath(): string {
  return (
    envText("EVALUATORQ_DASHBOARD_SETTINGS") ??
    ".evaluatorq/dashboard-settings.json"
  );
}

export function loadModelSettings(path = settingsPath()): ModelSettings {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(
        `Could not load dashboard settings from ${path} (${(error as Error).name}); using defaults`,
      );
    }
    return NO_SETTINGS();
  }
  const data = parseDashboardSettingsDocument(raw, path).toJSON();
  const roles: Partial<Record<Role, string>> = {};
  for (const role of ROLES) {
    const model = data[`${role}Model`];
    if (model) roles[role] = model;
  }
  return { roles, modelOverrides: { ...data.modelOverrides } };
}

type ModelSource = "flag" | "env" | "settings" | "default";

function resolve(
  role: Role,
  task?: string | null,
): { model: string; source: ModelSource; taskLevel: boolean } {
  if (task) {
    const owner = TASKS[task];
    if (!owner) {
      throw new Error(`unknown task '${task}'`);
    }
    if (owner !== role) {
      throw new Error(
        `task '${task}' belongs to role '${owner}', not '${role}'`,
      );
    }
  }
  const flags = hasCliModels()
    ? { roles: cliRoles as Record<string, string>, overrides: cliOverrides }
    : inheritedCliModels();
  const taskFlag = task ? flags.overrides[task] : undefined;
  if (taskFlag) {
    return { model: taskFlag, source: "flag", taskLevel: true };
  }
  const roleFlag = flags.roles[role];
  if (roleFlag) {
    return { model: roleFlag, source: "flag", taskLevel: false };
  }
  const legacy = task ? legacyEnv(task) : undefined;
  if (legacy) {
    return { model: legacy, source: "env", taskLevel: true };
  }
  const settings = loadModelSettings();
  const taskSetting = task ? settings.modelOverrides[task] : undefined;
  if (taskSetting) {
    return { model: taskSetting, source: "settings", taskLevel: true };
  }
  const fromEnv = envText(ROLE_ENV[role]);
  if (fromEnv) {
    return { model: fromEnv, source: "env", taskLevel: false };
  }
  const saved = settings.roles[role];
  if (saved) {
    return { model: saved, source: "settings", taskLevel: false };
  }
  return { model: BUILTIN[role], source: "default", taskLevel: false };
}

export function roleModel(
  role: Role,
  options: { task?: string | null } = {},
): string {
  return resolve(role, options.task).model;
}

export function roleSource(role: Role, task?: string | null): ModelSource {
  return resolve(role, task).source;
}

export function taskOverride(
  task: string,
): { model: string; label: string } | null {
  const owner = TASKS[task];
  if (!owner) {
    throw new Error(`unknown task '${task}'`);
  }
  const { model, source, taskLevel } = resolve(owner, task);
  if (!taskLevel) {
    return null;
  }
  const label =
    source === "flag"
      ? "--model-override"
      : source === "env"
        ? (LEGACY_TASK_ENV[task] ?? "environment")
        : "settings file";
  return { model, label };
}
