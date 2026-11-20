export const DEFAULT_ORQ_BASE_URL = "https://my.orq.ai";

export type EnvKind = "raw" | "int" | "float" | "bool";
export type EnvStatus = "set" | "rejected" | "unset";
type EnvDefault = string | number | boolean | null;

export interface EnvVar {
  name: string;
  kind: EnvKind;
  default: EnvDefault;
  description: string;
  minValue?: number;
  maxValue?: number;
  secret?: boolean;
  owner?: string;
}

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);
const ROLE_OWNER = "common/model-roles.roleModel";
const FINDER_OWNER = "trace-finder/settings.effectiveSettings";

function row(
  name: string,
  kind: EnvKind,
  defaultValue: EnvDefault,
  description: string,
  extra: Partial<EnvVar> = {},
): EnvVar {
  return { name, kind, default: defaultValue, description, ...extra };
}

const ROWS: readonly EnvVar[] = [
  row(
    "ORQ_API_KEY",
    "raw",
    null,
    "Orq platform API key; also enables tracing.",
    { secret: true },
  ),
  row("ORQ_BASE_URL", "raw", DEFAULT_ORQ_BASE_URL, "Orq API base URL."),
  row("HF_TOKEN", "raw", null, "Hugging Face token for private datasets.", {
    secret: true,
  }),
  row(
    "OPENAI_API_KEY",
    "raw",
    null,
    "OpenAI-compatible backend key when ORQ_API_KEY is absent.",
    { secret: true },
  ),
  row(
    "OPENAI_BASE_URL",
    "raw",
    null,
    "OpenAI-compatible host for the red teaming LLM client.",
  ),
  row(
    "EVALUATORQ_CATALOGUE_TIMEOUT_S",
    "float",
    30,
    "Model catalogue fetch timeout, read at import.",
    { minValue: 0.1 },
  ),
  row(
    "EVALUATORQ_FAST_MODEL",
    "raw",
    "openai/gpt-6-luna",
    "Model for the fast role.",
    { owner: ROLE_OWNER },
  ),
  row(
    "EVALUATORQ_SMART_MODEL",
    "raw",
    "openai/gpt-6-sol",
    "Model for the smart role.",
    { owner: ROLE_OWNER },
  ),
  row(
    "EVALUATORQ_CLASSIFIER_MODEL",
    "raw",
    "typesafe/jev-latest",
    "Model for the classifier role.",
    { owner: ROLE_OWNER },
  ),
  row(
    "EVALUATORQ_EMBEDDING_MODEL",
    "raw",
    "openai/text-embedding-3-small",
    "Model for the embedding role.",
    { owner: ROLE_OWNER },
  ),
  row(
    "EVALUATORQ_COMPILER_MODEL",
    "raw",
    null,
    "Deprecated finder.compiler task pin.",
    { owner: ROLE_OWNER },
  ),
  row("EVALUATORQ_APPLY_MODEL", "raw", null, "Deprecated apply task pin.", {
    owner: ROLE_OWNER,
  }),
  row("EVALUATORQ_DIR", "raw", null, "Run store directory; empty is unset."),
  row(
    "EQ_DEBUG",
    "raw",
    null,
    "Any non-empty value shows full CLI tracebacks.",
  ),
  row(
    "EVALUATORQ_LOG_LEVEL",
    "raw",
    "INFO",
    "Dashboard server and finder debug log level.",
  ),
  row("ORQ_WORKSPACE", "raw", null, "Workspace slug for dashboard deep-links."),
  row("ORQ_WORKSPACE_SLUG", "raw", null, "Fallback for ORQ_WORKSPACE."),
  row("ORQ_UI_BASE_URL", "raw", null, "Orq UI host for dashboard deep-links."),
  row(
    "EVALUATORQ_DASHBOARD_SETTINGS",
    "raw",
    ".evaluatorq/dashboard-settings.json",
    "Settings file path.",
  ),
  row(
    "EVALUATORQ_DASHBOARD_KEY_ENCRYPTION_KEY",
    "raw",
    null,
    "Fernet key that encrypts stored API keys off macOS.",
    { secret: true },
  ),
  row(
    "EVALUATORQ_FINDER_WINDOW_DAYS",
    "int",
    7,
    "Trace finder search window in days.",
    { minValue: 1, maxValue: 90, owner: FINDER_OWNER },
  ),
  row("EVALUATORQ_FINDER_LIMIT", "int", 500, "Trace finder trace limit.", {
    minValue: 1,
    maxValue: 5000,
    owner: FINDER_OWNER,
  }),
  row(
    "EVALUATORQ_FINDER_PARALLELISM",
    "int",
    100,
    "Trace finder classify concurrency.",
    { minValue: 1, maxValue: 200, owner: FINDER_OWNER },
  ),
  row(
    "ORQ_DISABLE_TRACING",
    "bool",
    false,
    "Suppress all OpenTelemetry spans.",
  ),
  row(
    "ORQ_DEBUG",
    "raw",
    null,
    "Any non-empty value prints tracing diagnostics.",
  ),
  row(
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "raw",
    null,
    "Explicit OTLP HTTP endpoint.",
  ),
  row("OTEL_EXPORTER_OTLP_HEADERS", "raw", null, "Extra OTLP export headers.", {
    secret: true,
  }),
  row("OTEL_SERVICE_NAME", "raw", "evaluatorq", "Span service.name."),
  row("OTEL_SERVICE_VERSION", "raw", "1.0.0", "Span service.version."),
  row(
    "ORQ_OTEL_MAX_QUEUE_SIZE",
    "int",
    4096,
    "BatchSpanProcessor queue size.",
    { minValue: 1 },
  ),
  row("ORQ_OTEL_MAX_BATCH_SIZE", "int", 512, "Spans per OTLP export request.", {
    minValue: 1,
  }),
  row(
    "ORQ_OTEL_SCHEDULE_DELAY_MS",
    "int",
    5000,
    "Partial batch export delay.",
    { minValue: 1 },
  ),
  row(
    "ORQ_OTEL_FLUSH_TIMEOUT_MS",
    "int",
    5000,
    "End-of-run force-flush timeout.",
    { minValue: 1 },
  ),
  row(
    "EVALUATORQ_CAPTURE_MESSAGE_CONTENT",
    "bool",
    true,
    "Record LLM messages, job payloads, and evaluator payloads on spans.",
  ),
  row(
    "EVALUATORQ_PROPAGATE_TRACE_CONTEXT",
    "bool",
    true,
    "Send W3C trace context on outgoing calls.",
  ),
  row(
    "EVALUATORQ_SPAN_MAX_TEXT_CHARS",
    "raw",
    null,
    "Per-attribute span text limit.",
  ),
  row(
    "EVALUATORQ_LLM_TIMEOUT_S",
    "float",
    60,
    "Simulation per-call LLM timeout.",
    { minValue: 1 },
  ),
  row(
    "EVALUATORQ_LLM_MAX_TOKENS",
    "int",
    10000,
    "Simulation per-call completion token cap.",
    { minValue: 1 },
  ),
  row(
    "EVALUATORQ_REASONING_EFFORT",
    "raw",
    null,
    "Reasoning effort for the simulator's own calls.",
  ),
];

export const ENV_VARS: ReadonlyMap<string, EnvVar> = new Map(
  ROWS.map((r) => [r.name, r]),
);

function declared(name: string, kind?: EnvKind): EnvVar {
  const found = ENV_VARS.get(name);
  if (!found) {
    throw new Error(`${name} is not declared in common/env-config ENV_VARS`);
  }
  if (kind && found.kind !== kind) {
    throw new Error(`${name} is declared as '${found.kind}', not '${kind}'`);
  }
  return found;
}

export function envRaw(name: string): string | undefined;
export function envRaw(name: string, defaultValue: string): string;
export function envRaw(
  name: string,
  defaultValue?: string,
): string | undefined {
  declared(name);
  return process.env[name] ?? defaultValue;
}

export function envText(name: string): string | undefined {
  declared(name);
  return process.env[name]?.trim() || undefined;
}

const INT_PATTERN = /^[+-]?\d+(?:_\d+)*$/;
const FLOAT_PATTERN =
  /^[+-]?(?:\d+(?:_\d+)*(?:\.(?:\d+(?:_\d+)*)?)?|\.\d+(?:_\d+)*)(?:[eE][+-]?\d+)?$/;
const NON_FINITE_PATTERN = /^[+-]?(?:nan|inf(?:inity)?)$/i;

type Parsed = {
  value: number | boolean | null;
  problem: string | null;
};

function parseNumber(found: EnvVar, value: string): Parsed {
  const isInt = found.kind === "int";
  if (!isInt && NON_FINITE_PATTERN.test(value)) {
    return { value: null, problem: `is not a finite number ('${value}')` };
  }
  if (!(isInt ? INT_PATTERN : FLOAT_PATTERN).test(value)) {
    return {
      value: null,
      problem: `is not ${isInt ? "an integer" : "a number"} ('${value}')`,
    };
  }
  const number = Number(value.replaceAll("_", ""));
  if (!Number.isFinite(number)) {
    return { value: null, problem: `is not a finite number ('${value}')` };
  }
  if (found.minValue !== undefined && number < found.minValue) {
    return {
      value: null,
      problem: `must be >= ${found.minValue} (got ${number})`,
    };
  }
  if (found.maxValue !== undefined && number > found.maxValue) {
    return {
      value: null,
      problem: `must be <= ${found.maxValue} (got ${number})`,
    };
  }
  return { value: number, problem: null };
}

function parse(found: EnvVar, raw: string): Parsed {
  const value = raw.trim();
  if (found.kind === "bool") {
    if (!value) {
      return { value: null, problem: null };
    }
    if (TRUE_VALUES.has(value.toLowerCase())) {
      return { value: true, problem: null };
    }
    if (FALSE_VALUES.has(value.toLowerCase())) {
      return { value: false, problem: null };
    }
    return { value: null, problem: `is not a boolean ('${raw}')` };
  }
  if (!value) {
    // An unresolved CI variable expands to empty, which should be a signal.
    return { value: null, problem: "is set but empty" };
  }
  return parseNumber(found, value);
}

function read<T extends number | boolean>(found: EnvVar): T {
  const defaultValue = found.default as T;
  const raw = process.env[found.name];
  if (raw === undefined) {
    return defaultValue;
  }
  const { value, problem } = parse(found, raw);
  if (problem !== null) {
    console.warn(`${found.name} ${problem}; using default ${defaultValue}.`);
  }
  return value === null ? defaultValue : (value as T);
}

export function envInt(name: string): number {
  return read<number>(declared(name, "int"));
}

export function envFloat(name: string): number {
  return read<number>(declared(name, "float"));
}

export function envBool(name: string): boolean {
  return read<boolean>(declared(name, "bool"));
}

export function maskSecret(value: string): string {
  if (value.length <= 4) {
    return "*".repeat(value.length);
  }
  return `${"*".repeat(Math.min(value.length - 4, 16))}${value.slice(-4)}`;
}

function status(found: EnvVar, raw: string | undefined): EnvStatus {
  if (raw === undefined) {
    return "unset";
  }
  if (!raw.trim() && (found.kind === "bool" || found.owner !== undefined)) {
    return "unset";
  }
  if (found.kind === "raw") {
    return "set";
  }
  return parse(found, raw).problem !== null ? "rejected" : "set";
}

export interface EnvReport {
  name: string;
  status: EnvStatus;
  value: string | null;
  default: EnvDefault;
  owner: string | null;
}

export function report(): EnvReport[] {
  return ROWS.map((found) => {
    const raw = process.env[found.name];
    return {
      name: found.name,
      status: status(found, raw),
      value: raw === undefined ? null : found.secret ? maskSecret(raw) : raw,
      default: found.default,
      owner: found.owner ?? null,
    };
  });
}
