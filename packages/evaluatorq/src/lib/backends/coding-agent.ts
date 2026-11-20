import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  extname,
  join,
  resolve,
  sep,
  win32,
} from "node:path";

import { z } from "zod/v4";

import { delimit, pythonString, pythonStrip } from "../common/sanitize.js";
import { NonRetryableTargetError } from "../common/target-call.js";
import {
  recordTokenUsage,
  setSpanAttrs,
  withLlmSpan,
} from "../common/tracing.js";
import {
  type AgentContext,
  AgentContextSchema,
  AgentResponse,
  AgentTarget,
  addUsage,
  contentToText,
  extractUsage,
  type Message,
  type TextOutputItem,
  TextOutputItemSchema,
  type ToolCallOutputItem,
  ToolCallOutputItemSchema,
  toChatCompletion,
  type Usage,
} from "../contracts.js";
import { parsePythonJson, pythonJson } from "../formats/json.js";
import {
  buildExecArgv,
  buildRunArgv,
  CODING_AGENT_BUILD_DIR,
  type DockerOptions,
  type DockerOptionsInput,
  dockerCli,
  dockerOptions,
  forwardedEnvNames,
  hostIds,
  isolationBreakingFlags,
  pyRepr,
  RESERVED_ENV,
  register,
  releaseContainers,
  removeContainersAsync,
  runControl,
  shellJoin,
  sweepOrphans,
  unregister,
  unsafeMounts,
  writeBeat,
} from "./container.js";

export type AgentName = "claude" | "codex" | "opencode";
export type Launcher = "direct" | "orq";
export type CallStatus = "in_progress" | "completed" | "incomplete";
type Event = Record<string, unknown>;

export const DEFAULT_CODING_AGENT_TIMEOUT_MS = 300_000;
export const DEFAULT_CODING_AGENT_MAX_TURN_MS = 7_200_000;
export const STDERR_EXCERPT_CHARS = 4000;

/** Seams tests replace: the host platform, binary lookup and the monotonic clock. */
export const codingAgentRuntime = {
  platform: (): NodeJS.Platform => process.platform,
  which: (command: string, path: string | undefined): string | null =>
    which(command, path),
  monotonic: (): number => performance.now() / 1000,
};

interface FailureFields {
  readonly code: string;
  readonly detail: string;
  readonly killReason: string | null;
}

/**
 * A coding-agent turn failed. `code` is one of the `cli.*` codes `mapError` reports: `cli.not_found`,
 * `cli.timeout`, `cli.container_start`, `cli.image_missing`, `cli.prompt_too_long`,
 * `cli.agent_not_found`, `cli.exit.<code>`, `cli.no_result`, `cli.parse_error`, `cli.agent_error`.
 */
export class CodingAgentError extends Error implements FailureFields {
  readonly killReason: string | null;
  constructor(
    readonly code: string,
    readonly detail: string,
    options: { killReason?: string | null } = {},
  ) {
    super(`${code}: ${detail}`);
    this.name = "CodingAgentError";
    this.killReason = options.killReason ?? null;
  }

  static override [Symbol.hasInstance](value: unknown): boolean {
    return (
      Function.prototype[Symbol.hasInstance].call(CodingAgentError, value) ||
      Function.prototype[Symbol.hasInstance].call(
        CodingAgentUnavailableError,
        value,
      )
    );
  }
}

/**
 * Non-retryable codes: `cli.not_found`, `cli.timeout`, `cli.prompt_too_long`, `cli.agent_not_found`,
 * `cli.image_missing`, `cli.container_start` and `cli.unsafe_shim`. It is also a `CodingAgentError`.
 */
export class CodingAgentUnavailableError
  extends NonRetryableTargetError
  implements FailureFields
{
  readonly killReason: string | null;
  constructor(
    readonly code: string,
    readonly detail: string,
    options: { killReason?: string | null } = {},
  ) {
    super(`${code}: ${detail}`);
    this.name = "CodingAgentUnavailableError";
    this.killReason = options.killReason ?? null;
  }
}

export const OrqLaunchOptionsSchema = z.preprocess(
  (raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const value = raw as Record<string, unknown>;
    return {
      ...value,
      baseUrl: "baseUrl" in value ? value.baseUrl : value.base_url,
      fetchModels:
        "fetchModels" in value ? value.fetchModels : value.fetch_models,
    };
  },
  z.object({
    mcp: z.boolean().default(true),
    skills: z.boolean().default(true),
    baseUrl: z.string().nullable().default(null),
    fetchModels: z.boolean().default(true),
  }),
);
export type OrqLaunchOptions = z.infer<typeof OrqLaunchOptionsSchema>;
export type OrqLaunchOptionsInput = z.input<typeof OrqLaunchOptionsSchema>;

export function orqLaunchFlags(input: OrqLaunchOptionsInput = {}): string[] {
  const opts = OrqLaunchOptionsSchema.parse(input);
  const flags: string[] = [];
  if (!opts.mcp) flags.push("--no-mcp");
  if (!opts.skills) flags.push("--no-skills");
  if (opts.baseUrl) flags.push("--base-url", opts.baseUrl);
  if (!opts.fetchModels) flags.push("--no-fetch-models");
  return flags;
}

export interface AgentSpec {
  readonly binary: string;
  readonly outputArgs: readonly string[];
  readonly modelFlag: string;
  readonly permissionFlag: string | null;
  readonly systemPromptFlag: string | null;
  readonly skillsDir: string;
  readonly tools: readonly string[];
  readonly containerPermission: string | null;
  readonly containerExtraArgs: readonly string[];
  readonly providerEnv: readonly string[];
  readonly stdinMarker: readonly string[];
}

export const AGENTS: Readonly<Record<AgentName, AgentSpec>> = Object.freeze({
  claude: Object.freeze({
    binary: "claude",
    outputArgs: ["-p", "--output-format", "stream-json", "--verbose"],
    modelFlag: "--model",
    permissionFlag: "--permission-mode",
    systemPromptFlag: "--append-system-prompt",
    skillsDir: ".claude/skills",
    tools: ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch"],
    containerPermission: "bypassPermissions",
    containerExtraArgs: [],
    providerEnv: ["ANTHROPIC_API_KEY"],
    stdinMarker: [],
  }),
  codex: Object.freeze({
    binary: "codex",
    outputArgs: ["exec", "--json", "--skip-git-repo-check"],
    modelFlag: "-m",
    permissionFlag: "--sandbox",
    systemPromptFlag: null,
    skillsDir: ".agents/skills",
    tools: ["shell", "apply_patch"],
    // Codex's own sandbox often cannot start inside a container; the container is the sandbox.
    containerPermission: "danger-full-access",
    containerExtraArgs: [],
    providerEnv: ["OPENAI_API_KEY"],
    stdinMarker: ["-"],
  }),
  opencode: Object.freeze({
    binary: "opencode",
    outputArgs: ["run", "--format", "json"],
    modelFlag: "--model",
    permissionFlag: null,
    systemPromptFlag: null,
    skillsDir: ".agents/skills",
    tools: ["bash", "read", "edit", "write", "glob", "grep"],
    containerPermission: null,
    containerExtraArgs: ["--auto"],
    providerEnv: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
    stdinMarker: [],
  }),
});

/**
 * Return `[argv, stdinText]`; `stdinText` is null when the child's stdin must be closed. Under `orq`
 * the codex and opencode prompts go through `orq launch -p`, because codex appends any open stdin.
 */
export function buildArgv(args: {
  agent: AgentName;
  launcher: Launcher;
  model?: string | null;
  permissionMode?: string | null;
  systemPrompt?: string | null;
  extraArgs?: readonly string[] | null;
  orq?: OrqLaunchOptionsInput | null;
  prompt: string;
}): [string[], string | null] {
  const spec = AGENTS[args.agent];
  const permissionMode = args.permissionMode ?? null;
  if (permissionMode !== null && spec.permissionFlag === null)
    throw new Error(
      `${args.agent} has no permission-mode flag; pass its own flags through extra_args instead`,
    );
  const agentArgs = [...spec.outputArgs];
  if (args.launcher === "direct" && args.model)
    agentArgs.push(spec.modelFlag, args.model);
  if (permissionMode !== null && spec.permissionFlag !== null)
    agentArgs.push(spec.permissionFlag, permissionMode);
  if (args.systemPrompt && spec.systemPromptFlag)
    agentArgs.push(spec.systemPromptFlag, args.systemPrompt);
  agentArgs.push(...(args.extraArgs ?? []));
  if (args.launcher === "direct")
    return [[spec.binary, ...agentArgs, ...spec.stdinMarker], args.prompt];
  const orqFlags = args.model ? ["--model", args.model] : [];
  orqFlags.push(...orqLaunchFlags(args.orq ?? {}));
  if (args.agent === "claude")
    return [
      ["orq", "launch", "claude", ...orqFlags, "--", ...agentArgs],
      args.prompt,
    ];
  return [
    [
      "orq",
      "launch",
      args.agent,
      ...orqFlags,
      "-p",
      args.prompt,
      "--",
      ...agentArgs.slice(1),
    ],
    null,
  ];
}

// cmd.exe re-parses a batch launcher's command line and Node does not escape for it (BatBadBut).
const CMD_METACHARACTERS = new Set([
  '"',
  "%",
  "&",
  "|",
  "<",
  ">",
  "^",
  "!",
  "\r",
  "\n",
]);

export function isBatchLauncher(executable: string): boolean {
  return (
    codingAgentRuntime.platform() === "win32" &&
    [".bat", ".cmd"].includes(extname(executable).toLowerCase())
  );
}

export function refuseUnsafeBatchArgs(argv: readonly string[]): void {
  const [executable = "", ...rest] = argv;
  if (!isBatchLauncher(executable)) return;
  const native =
    win32.parse(executable).name.toLowerCase() === "orq"
      ? "download orq-win32-x64.exe from https://github.com/orq-ai/orq-cli/releases and put it on PATH as orq.exe"
      : "install the agent CLI as a native .exe";
  for (const arg of rest) {
    const found = [
      ...new Set([...arg].filter((c) => CMD_METACHARACTERS.has(c))),
    ].sort();
    if (found.length)
      throw new CodingAgentUnavailableError(
        "cli.unsafe_shim",
        `${executable} is a Windows batch-file launcher, and cmd.exe would interpret ` +
          `${found.map(pyRepr).join(", ")} in the argument ${pyRepr(arg)}. Remove those characters from ` +
          `\`extra_args\` or \`model\`, or ${native} so evaluatorq can call it directly.`,
      );
  }
}

export const PROMPT_INSTRUCTION =
  "You are continuing the conversation below. It is a JSON array of chat messages in order; " +
  '"tool" entries are the results of your own earlier tool calls. Reply to the last "user" message. ' +
  "Do not restate the transcript.";

export function messageToDict(message: Message): Record<string, unknown> {
  if (message.role === "tool")
    return {
      role: "tool",
      tool_call_id: message.tool_call_id || "",
      name: message.name ?? null,
      content: contentToText(message.content),
    };
  const out: Record<string, unknown> = {
    role: message.role,
    content: message.content === null ? null : contentToText(message.content),
  };
  if (message.tool_calls?.length)
    out.tool_calls = message.tool_calls.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    }));
  return out;
}

/** The transcript as a delimited JSON conversation followed by the reply instruction. */
export function renderPrompt(
  messages: readonly Message[],
  options: { systemPrompt?: string | null; inlineSystem: boolean },
): string {
  const entries: Record<string, unknown>[] = [];
  if (options.inlineSystem && options.systemPrompt)
    entries.push({ role: "system", content: options.systemPrompt });
  entries.push(...messages.map(messageToDict));
  const block = delimit(pythonJson(entries, { ensureAscii: false }), {
    tag: "conversation",
  });
  return `${PROMPT_INSTRUCTION}\n${block}`;
}

/** What one agent run said, before the exit-code and error-order checks in `respond()`. */
export interface ParsedTurn {
  text: string | null;
  toolCalls: ToolCallOutputItem[];
  usage: Usage | null;
  sessionId: string | null;
  model: string | null;
  costUsd: number | null;
  agentError: string | null;
}

function emptyTurn(): ParsedTurn {
  return {
    text: null,
    toolCalls: [],
    usage: null,
    sessionId: null,
    model: null,
    costUsd: null,
    agentError: null,
  };
}

/** Python's `json.dumps(result, default=str)` for any tool result that is not already text. */
export function toolResultToText(result: unknown): string {
  if (typeof result === "string") return result;
  return pythonJson(result === undefined ? null : result, {
    defaultString: true,
  });
}

function toolCall(args: {
  callId: string;
  name: string;
  arguments: unknown;
  result: string | null;
  status: CallStatus;
}): ToolCallOutputItem {
  return ToolCallOutputItemSchema.parse({
    type: "function_call",
    id: args.callId,
    call_id: args.callId,
    name: args.name,
    arguments:
      typeof args.arguments === "string"
        ? args.arguments
        : pythonJson(args.arguments === undefined ? null : args.arguments, {
            ensureAscii: false,
          }),
    status: args.status,
    result: args.result,
  });
}

const isRecord = (value: unknown): value is Event =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const record = (value: unknown): Event => (isRecord(value) ? value : {});
const get = (value: unknown, key: string, fallback?: unknown): unknown =>
  isRecord(value) && key in value ? value[key] : fallback;
const str = (value: unknown): string => pythonString(value);
const asList = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];
const nullable = <T>(value: unknown): T | null =>
  value === undefined ? null : (value as T);

function usageOrNone(
  agent: string,
  block: unknown,
  required: readonly string[],
): Usage | null {
  if (block === null || block === undefined) return null;
  const missing = required.filter(
    (field) => !isRecord(block) || !(field in block),
  );
  if (missing.length) {
    console.warn(
      `${agent} usage missing required field(s): ${missing.join(", ")}; usage is None`,
    );
    return null;
  }
  return extractUsage(block, 1);
}

/** OpenCode's `step_finish.tokens` in the canonical names `extractUsage` reads; `total` is left out. */
export function opencodeUsage(tokens: unknown): Event | null {
  if (!isRecord(tokens)) return null;
  const cache = record(tokens.cache);
  const renamed: Event = {
    input_tokens: tokens.input,
    output_tokens: tokens.output,
    cache_read_input_tokens: cache.read,
    cache_creation_input_tokens: cache.write,
  };
  if (tokens.reasoning !== null && tokens.reasoning !== undefined)
    renamed.output_tokens_details = { reasoning_tokens: tokens.reasoning };
  return Object.fromEntries(
    Object.entries(renamed).filter(([, v]) => v !== null && v !== undefined),
  );
}

/** The `modelUsage` entry with the most tokens; the first key is often an auxiliary model. */
export function heaviestModel(modelUsage: unknown): string | null {
  let best: string | null = null,
    bestTokens = Number.NEGATIVE_INFINITY;
  for (const [model, value] of Object.entries(record(modelUsage))) {
    const tokens =
      Number(get(value, "inputTokens", 0)) +
      Number(get(value, "outputTokens", 0));
    if (tokens > bestTokens) {
      best = model;
      bestTokens = tokens;
    }
  }
  return best;
}

const CLAUDE_HOUSEKEEPING_EVENTS = new Set(["system", "rate_limit_event"]);

export function parseClaude(events: readonly Event[]): ParsedTurn {
  const turn = emptyTurn();
  const calls = new Map<string, ToolCallOutputItem>();
  const order: string[] = [];
  let lastText: string[] = [];
  for (const event of events) {
    const kind = event.type;
    if (CLAUDE_HOUSEKEEPING_EVENTS.has(kind as string)) continue;
    const message = get(event, "message", {});
    if (kind === "assistant") {
      turn.model = (get(message, "model") as string | undefined) || turn.model;
      lastText = [];
      for (const block of asList(get(message, "content", []))) {
        if (get(block, "type") === "tool_use") {
          const callId = str(get(block, "id"));
          calls.set(
            callId,
            toolCall({
              callId,
              name: str(get(block, "name")),
              arguments: get(block, "input", {}),
              result: null,
              status: "in_progress",
            }),
          );
          order.push(callId);
        } else if (get(block, "type") === "text")
          lastText.push(str(get(block, "text", "")));
      }
    } else if (kind === "user") {
      for (const block of asList(get(message, "content", []))) {
        if (!isRecord(block) || block.type !== "tool_result") continue;
        const callId = str(block.tool_use_id);
        const existing = calls.get(callId);
        if (existing)
          calls.set(callId, {
            ...existing,
            result: toolResultToText(block.content),
            status: block.is_error ? "incomplete" : "completed",
          });
      }
    } else if (kind === "result") {
      turn.sessionId = nullable(event.session_id);
      turn.costUsd = nullable(event.total_cost_usd);
      const resultText = event.result;
      turn.text =
        typeof resultText === "string" ? resultText : lastText.join("") || null;
      if (event.is_error)
        turn.agentError =
          typeof resultText === "string" ? resultText : str(event.subtype);
      turn.usage = usageOrNone("claude", event.usage, [
        "input_tokens",
        "output_tokens",
      ]);
      turn.model = turn.model || heaviestModel(event.modelUsage || {});
      for (const denial of asList(event.permission_denials)) {
        const callId = str(
          get(denial, "tool_use_id") || `denied-${order.length}`,
        );
        const denied = toolCall({
          callId,
          name: str(get(denial, "tool_name")),
          arguments: get(denial, "tool_input", {}),
          result: "[denied by claude]",
          status: "incomplete",
        });
        if (!calls.has(callId)) order.push(callId);
        calls.set(callId, denied);
      }
    } else console.warn(`claude skipped unknown event type: ${str(kind)}`);
  }
  if (turn.text === null && lastText.length) turn.text = lastText.join("");
  turn.toolCalls = order.map((id) => calls.get(id) as ToolCallOutputItem);
  return turn;
}

function codexStatus(item: Event): CallStatus {
  const status = item.status;
  if (
    status === "completed" &&
    (item.exit_code === undefined ||
      item.exit_code === null ||
      item.exit_code === 0)
  )
    return "completed";
  if (status === "in_progress" || status === undefined || status === null)
    return "in_progress";
  return "incomplete";
}

export function parseCodex(events: readonly Event[]): ParsedTurn {
  const turn = emptyTurn();
  const calls = new Map<string, ToolCallOutputItem>();
  const order: string[] = [];
  for (const event of events) {
    const kind = event.type;
    if (kind === "thread.started") turn.sessionId = nullable(event.thread_id);
    else if (kind === "turn.failed")
      turn.agentError = str(get(event.error || {}, "message") || "turn.failed");
    else if (kind === "turn.completed")
      turn.usage = usageOrNone("codex", event.usage, [
        "input_tokens",
        "output_tokens",
      ]);
    else if (kind === "item.started" || kind === "item.completed") {
      const item = record(event.item || {});
      const itemId = str(item.id);
      const itemType = item.type;
      if (itemType === "agent_message") turn.text = str(get(item, "text", ""));
      else if (itemType === "error")
        console.warn(`codex reported: ${str(item.message)}`);
      else if (itemType === "command_execution")
        calls.set(
          itemId,
          toolCall({
            callId: itemId,
            name: "shell",
            arguments: { command: nullable(item.command) },
            result:
              kind === "item.completed"
                ? nullable(item.aggregated_output)
                : null,
            status: codexStatus(item),
          }),
        );
      else if (itemType === "file_change")
        calls.set(
          itemId,
          toolCall({
            callId: itemId,
            name: "apply_patch",
            arguments: { changes: get(item, "changes", []) },
            result: item.status === "completed" ? "applied" : null,
            status: codexStatus(item),
          }),
        );
      else if (itemType === "mcp_tool_call") {
        const error = item.error || {};
        const hasError = isRecord(error)
          ? Object.keys(error).length > 0
          : Boolean(error);
        calls.set(
          itemId,
          toolCall({
            callId: itemId,
            name: `${str(item.server)}.${str(item.tool)}`,
            arguments: get(item, "arguments", {}),
            result: hasError
              ? nullable(get(error, "message"))
              : toolResultToText(item.result),
            status: hasError ? "incomplete" : codexStatus(item),
          }),
        );
      } else {
        console.warn(`codex skipped unknown item type: ${str(itemType)}`);
        continue;
      }
      if (calls.has(itemId) && !order.includes(itemId)) order.push(itemId);
    } else console.warn(`codex skipped unknown event type: ${str(kind)}`);
  }
  turn.toolCalls = order.map((id) => calls.get(id) as ToolCallOutputItem);
  return turn;
}

export function parseOpencode(events: readonly Event[]): ParsedTurn {
  const turn = emptyTurn();
  let lastText: string | null = null,
    cost = 0,
    sawStepFinish = false,
    sawCost = false;
  for (const event of events) {
    turn.sessionId = turn.sessionId || nullable(event.sessionID);
    const part = record(event.part || {});
    const kind = event.type;
    if (kind === "text") lastText = str(get(part, "text", ""));
    else if (kind === "tool_use") {
      const state = record(part.state || {});
      const status: CallStatus =
        state.status === "completed"
          ? "completed"
          : state.status === "error"
            ? "incomplete"
            : "in_progress";
      const callId = str(part.callID || part.id);
      turn.toolCalls.push(
        toolCall({
          callId,
          name: str(part.tool),
          arguments: get(state, "input", {}),
          result:
            state.output !== null && state.output !== undefined
              ? toolResultToText(state.output)
              : "error" in state
                ? toolResultToText(state.error)
                : null,
          status,
        }),
      );
    } else if (kind === "step_finish") {
      sawStepFinish = true;
      const stepUsage = usageOrNone("opencode", opencodeUsage(part.tokens), [
        "input_tokens",
        "output_tokens",
      ]);
      if (stepUsage !== null)
        turn.usage =
          turn.usage === null ? stepUsage : addUsage(turn.usage, stepUsage);
      if ("cost" in part) {
        sawCost = true;
        cost += Number(part.cost || 0);
      }
    } else if (kind === "error")
      turn.agentError = str(
        get(part.error || event.error || {}, "message") || "error",
      );
    else console.warn(`opencode skipped unknown event type: ${str(kind)}`);
  }
  if (lastText !== null) turn.text = lastText;
  if (sawStepFinish && turn.usage === null)
    console.warn(
      "opencode step_finish carried no usable token counts; usage is unknown",
    );
  if (sawCost) turn.costUsd = cost;
  return turn;
}

const PARSERS: Readonly<
  Record<AgentName, (events: readonly Event[]) => ParsedTurn>
> = {
  claude: parseClaude,
  codex: parseCodex,
  opencode: parseOpencode,
};

/** Pure: one agent's JSONL events to a `ParsedTurn`. Unknown event types are skipped. */
export function parseEvents(
  agent: AgentName,
  events: readonly Event[],
): ParsedTurn {
  return PARSERS[agent](events);
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: mirrors Python str.splitlines boundaries
const SPLITLINES = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;

function tryJson(line: string): unknown {
  try {
    return parsePythonJson(line);
  } catch {
    return undefined;
  }
}

export function parseJsonl(stdout: string): Event[] {
  const events: Event[] = [];
  for (const raw of stdout.split(SPLITLINES)) {
    const line = pythonStrip(raw);
    if (!line) continue;
    const parsed = tryJson(line);
    if (parsed === undefined) {
      console.warn(
        `CodingAgentTarget: skipping non-JSON stdout line: ${line.slice(0, 200)}`,
      );
      continue;
    }
    if (isRecord(parsed)) events.push(parsed);
  }
  return events;
}

/** The last complete JSON event type and the tool or item it names, when present. */
export function describeLastEvent(stdout: string): string {
  const lines = stdout.split(/\r\n|\r|\n/);
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines.reverse()) {
    const event = tryJson(line);
    if (!isRecord(event)) continue;
    const item = event.item,
      part = event.part;
    let detail: unknown =
      (isRecord(item) ? item.type : null) ||
      (isRecord(part) ? part.tool : null);
    const content = isRecord(event.message) ? event.message.content : null;
    const last = Array.isArray(content) ? content.at(-1) : undefined;
    if ((detail === null || detail === undefined) && isRecord(last))
      detail = last.name || last.type;
    return detail ? `${str(event.type)} ${str(detail)}` : str(event.type);
  }
  return "none";
}

/** The one log line every early end of an agent run writes, so a report row can say which limit fired. */
export function logKill(agent: string, reason: string, detail: string): void {
  console.warn(`CodingAgentTarget(${agent}) ${reason}: ${detail}`);
}

function clockStamp(secondsAgo: number): string {
  const at = new Date(Date.now() - secondsAgo * 1000);
  return [at.getHours(), at.getMinutes(), at.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

export function deadlineError(
  agent: string,
  stdout: string,
  started: number,
  lastOutput: number,
  idleS: number,
  hardS: number,
  now: number,
): CodingAgentUnavailableError | null {
  if (now >= started + hardS) {
    const detail = `turn exceeded ${hardS.toFixed(0)}s (${stdout.split("\n").length - 1} events)`;
    logKill(agent, "hard_cap", detail);
    return new CodingAgentUnavailableError("cli.timeout", detail, {
      killReason: "hard_cap",
    });
  }
  if (now >= lastOutput + idleS) {
    const detail = `no output for ${idleS.toFixed(0)}s (last event: ${describeLastEvent(stdout)} at ${clockStamp(now - lastOutput)})`;
    logKill(agent, "idle_timeout", detail);
    return new CodingAgentUnavailableError("cli.timeout", detail, {
      killReason: "idle_timeout",
    });
  }
  return null;
}

/** `shutil.which`: search `path` for an executable, honouring PATHEXT on Windows. */
export function which(
  command: string,
  path: string | undefined,
): string | null {
  const windows = codingAgentRuntime.platform() === "win32";
  const exts = windows
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  const candidates = (base: string) =>
    windows && !exts.some((e) => base.toLowerCase().endsWith(e.toLowerCase()))
      ? exts.map((e) => base + e)
      : [base];
  const usable = (file: string) => {
    try {
      accessSync(file, windows ? constants.F_OK : constants.X_OK);
      return !lstatSync(file).isDirectory() || false;
    } catch {
      return false;
    }
  };
  if (command.includes("/") || (windows && command.includes("\\")))
    return candidates(command).find(usable) ?? null;
  for (const dir of (path ?? "").split(delimiter)) {
    if (!dir) continue;
    const found = candidates(join(dir, command)).find(usable);
    if (found) return found;
  }
  return null;
}

function killDirect(proc: ChildProcess): void {
  try {
    proc.kill("SIGKILL");
  } catch {}
}

function taskkillTree(pid: number): boolean {
  const result = spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.error) {
    console.warn(
      `CodingAgentTarget: taskkill could not end process tree ${pid}, killing the agent process only: ${result.error.message}`,
    );
    return false;
  }
  if (result.status !== 0) {
    const detail = pythonStrip(result.stderr || result.stdout || "").slice(
      0,
      STDERR_EXCERPT_CHARS,
    );
    console.warn(
      `CodingAgentTarget: taskkill exited ${result.status} for process tree ${pid}, ` +
        `killing the agent process only; its children may still be running: ${detail}`,
    );
    return false;
  }
  return true;
}

function exited(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null;
}

/** Kill the agent's process group (a process tree on Windows). */
export function killGroup(
  proc: ChildProcess,
  options: { force?: boolean } = {},
): void {
  if (exited(proc) && !options.force) return;
  if (proc.pid === undefined) return;
  if (codingAgentRuntime.platform() === "win32") {
    if (!exited(proc) && !taskkillTree(proc.pid)) killDirect(proc);
    return;
  }
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {}
}

function returnCode(
  code: number | null,
  signal: NodeJS.Signals | null,
): number {
  if (code !== null) return code;
  if (signal !== null) return -(osConstants.signals[signal] ?? 0);
  return 0;
}

function abortError(signal: AbortSignal): unknown {
  return (
    signal.reason ??
    Object.assign(new Error("This operation was aborted"), {
      name: "AbortError",
    })
  );
}

function resolveLoose(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(resolveLoose(parent), basename(path));
  }
}

function isRelativeTo(path: string, root: string): boolean {
  return (
    path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
  );
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

const workdirRegistry = new FinalizationRegistry<string>((root) =>
  rmSync(root, { recursive: true, force: true }),
);
const containerRegistry = new FinalizationRegistry<string[]>((owned) =>
  releaseContainers(owned),
);

export interface CodingAgentTargetOptions {
  launcher?: Launcher;
  orq?: OrqLaunchOptionsInput | null;
  model?: string | null;
  systemPrompt?: string | null;
  permissionMode?: string | null;
  extraArgs?: readonly string[] | null;
  workdir?: string | null;
  keepWorkdir?: boolean;
  skills?: readonly string[] | null;
  timeoutMs?: number;
  maxTurnMs?: number;
  env?: Record<string, string> | null;
  container?: DockerOptions | DockerOptionsInput | null;
}

type RunResult = [number, string, string];

/**
 * Run a local coding-agent CLI as the system under test. Each `respond()` spawns a fresh process in a
 * working directory private to this instance; `newInstance()` clones get their own copy. `close()`
 * kills a live process group and removes the temp dir unless `keepWorkdir` is set. With `container`,
 * one long-lived container belongs to each clone and each turn runs through `docker exec`.
 */
export class CodingAgentTarget extends AgentTarget {
  override readonly managesOwnTimeout = true;
  readonly agent: AgentName;
  readonly timeoutMs: number;
  readonly maxTurnMs: number;
  private readonly spec: AgentSpec;
  private readonly options: CodingAgentTargetOptions;
  private readonly launcher: Launcher;
  private readonly orq: OrqLaunchOptionsInput | null;
  private readonly model: string | null;
  private readonly systemPrompt: string | null;
  private readonly permissionMode: string | null;
  private readonly extraArgs: string[];
  private readonly sourceWorkdir: string | null;
  private readonly keepWorkdir: boolean;
  private readonly skills: string[];
  private readonly env: Record<string, string>;
  private readonly container: DockerOptions | null;
  private readonly forwardEnv: string[];
  private currentWorkdir: string | null = null;
  private root: string | null = null;
  private containerName: string | null = null;
  private restarts = 0;
  private imageChecked = false;
  private readonly owned: string[] = [];
  private proc: ChildProcess | null = null;
  private readonly finalizerToken = {};

  constructor(agent: AgentName, options: CodingAgentTargetOptions = {}) {
    super();
    if (!(agent in AGENTS))
      throw new Error(
        `Unknown coding agent ${pyRepr(String(agent))}; expected one of ['claude', 'codex', 'opencode']`,
      );
    const launcher = options.launcher ?? "direct";
    if (launcher !== "direct" && launcher !== "orq")
      throw new Error(
        `Unknown launcher ${pyRepr(String(launcher))}; expected "direct" or "orq"`,
      );
    const timeoutMs = options.timeoutMs ?? DEFAULT_CODING_AGENT_TIMEOUT_MS;
    const maxTurnMs = options.maxTurnMs ?? DEFAULT_CODING_AGENT_MAX_TURN_MS;
    if (timeoutMs <= 0 || maxTurnMs <= 0)
      throw new Error("timeout_ms and max_turn_ms must be positive");
    this.spec = AGENTS[agent];
    this.options = { ...options };
    const container = options.container
      ? dockerOptions(options.container)
      : null;
    this.container = container;
    let permissionMode = options.permissionMode ?? null;
    let extraArgs = [...(options.extraArgs ?? [])];
    const env = { ...(options.env ?? {}) };
    if (container) {
      if (container.allowPrivilegeEscalation)
        console.warn(
          `CodingAgentTarget(${agent}): allow_privilege_escalation=True drops no-new-privileges; ` +
            "container commands can gain privileges through installed setuid programs",
        );
      if (permissionMode === null)
        permissionMode = this.spec.containerPermission;
      extraArgs = [
        ...extraArgs,
        ...this.spec.containerExtraArgs.filter((a) => !extraArgs.includes(a)),
      ];
      for (const flag of isolationBreakingFlags(container.runArgs))
        console.warn(
          `CodingAgentTarget(${agent}): run_args ${pyRepr(flag)} undoes the container isolation`,
        );
      const dropped = RESERVED_ENV.filter((key) => key in env);
      if (dropped.length)
        console.warn(
          `CodingAgentTarget(${agent}): env ${dropped.join(", ")} not forwarded into the container; ` +
            "it applies to the docker client only",
        );
    }
    if (permissionMode !== null && this.spec.permissionFlag === null)
      throw new Error(
        `${agent} has no permission-mode flag; pass its own flags through extra_args instead`,
      );
    if (options.orq && launcher === "direct")
      console.warn(
        `CodingAgentTarget(${agent}): orq options given but launcher is "direct"; ignoring them`,
      );
    if (options.systemPrompt && this.spec.systemPromptFlag === null)
      console.warn(
        `CodingAgentTarget(${agent}): no system-prompt flag; prepending system_prompt to the conversation instead`,
      );
    this.agent = agent;
    this.launcher = launcher;
    this.orq = options.orq ?? null;
    this.model = options.model ?? null;
    this.systemPrompt = options.systemPrompt ?? null;
    this.permissionMode = permissionMode;
    this.extraArgs = extraArgs;
    this.sourceWorkdir = options.workdir ?? null;
    this.keepWorkdir = options.keepWorkdir ?? false;
    this.skills = [...(options.skills ?? [])];
    this.timeoutMs = timeoutMs;
    this.maxTurnMs = maxTurnMs;
    this.env = env;
    this.forwardEnv = container
      ? forwardedEnvNames(container, {
          launcher,
          providerEnv: this.spec.providerEnv,
          callerEnv: env,
        })
      : [];
    if (container)
      containerRegistry.register(this, this.owned, this.finalizerToken);
  }

  /** The private working directory, null until the first turn creates it. */
  get workdir(): string | null {
    return this.currentWorkdir;
  }

  private async docker(argv: string[], timeoutS = 60) {
    const opts = this.container;
    if (!opts)
      throw new Error("container options are required for Docker calls");
    const result = await runControl(argv, timeoutS);
    if (result.error?.code === "ENOENT")
      throw new CodingAgentUnavailableError(
        "cli.not_found",
        `${pyRepr(opts.binary)} not found on PATH`,
      );
    if (result.error || result.timedOut) {
      const operation =
        argv.find((arg) =>
          ["image", "run", "inspect", "exec", "rm", "ps"].includes(arg),
        ) ?? "control";
      const detail = result.timedOut
        ? `Command timed out after ${timeoutS} seconds`
        : pythonStrip(
            (result.error?.message ?? "").slice(0, STDERR_EXCERPT_CHARS),
          ) ||
          (result.error?.name ?? "Error");
      throw new CodingAgentUnavailableError(
        "cli.container_start",
        `${opts.binary} ${operation} control call failed: ${detail}`,
      );
    }
    return {
      returncode: result.status ?? -1,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  private async ensureContainer(root: string): Promise<string> {
    const opts = this.container;
    if (!opts)
      throw new Error("container options are required to start a container");
    const cli = dockerCli(opts);
    if (this.containerName !== null) {
      const state = await this.docker([
        ...cli,
        "inspect",
        "-f",
        "{{.State.Running}}",
        this.containerName,
      ]);
      if (state.returncode === 0 && pythonStrip(state.stdout) === "true")
        return this.containerName;
      const oldName = this.containerName;
      const marker = join(root, "home", ".evq-exit");
      const cause = existsSync(marker)
        ? pythonStrip(readFileSync(marker, "utf8"))
        : null;
      try {
        unlinkSync(marker);
      } catch {}
      logKill(
        this.agent,
        cause ? "lease_expired" : "container_lost",
        `container ${oldName} stopped between turns (${cause || "cause unknown"}); recreating it. ` +
          "Files in the workdir and home survive; processes the agent started in the background do not",
      );
      await this.dropContainer();
      this.restarts++;
    } else if (!this.imageChecked) {
      const inspected = await this.docker([
        ...cli,
        "image",
        "inspect",
        opts.image,
      ]);
      if (inspected.returncode !== 0) {
        const detail = pythonStrip(
          inspected.stderr.slice(-STDERR_EXCERPT_CHARS),
        );
        const lower = detail.toLowerCase();
        if (
          ["no such image", "no such object", "image not known"].some((p) =>
            lower.includes(p),
          )
        )
          throw new CodingAgentUnavailableError(
            "cli.image_missing",
            `image ${pyRepr(opts.image)} not found. Build it with ` +
              `\`${shellJoin(["eq", "coding-agent", "build-image", "--tag", opts.image])}\` ` +
              `or \`${shellJoin([opts.binary, "build", "-t", opts.image, CODING_AGENT_BUILD_DIR])}\``,
          );
        throw new CodingAgentUnavailableError(
          "cli.container_start",
          `${opts.binary} image inspect failed: ${detail || "Docker returned no error details"}`,
        );
      }
      this.imageChecked = true;
      await sweepOrphans(opts.binary, opts.context);
    }
    for (const source of unsafeMounts(opts.runArgs, root))
      console.warn(
        `CodingAgentTarget(${this.agent}): run_args mount source ${pyRepr(source)} is outside the private workdir; ` +
          "the agent can reach it",
      );
    const name = `${opts.namePrefix}-${this.agent}-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const leaseDir = join(root, "lease", name);
    mkdirSync(leaseDir);
    const beat = join(leaseDir, "beat");
    writeBeat(beat, 0);
    register(name, { binary: opts.binary, context: opts.context, beat });
    this.owned.push(name);
    this.containerName = name;
    const [uid, gid] = hostIds();
    let started: Awaited<ReturnType<CodingAgentTarget["docker"]>>;
    try {
      started = await this.docker(
        buildRunArgv(opts, { name, root, leaseDir, uid, gid }),
      );
    } catch (error) {
      await this.dropContainer();
      throw error;
    }
    if (started.returncode !== 0) {
      await this.dropContainer();
      throw new CodingAgentUnavailableError(
        "cli.container_start",
        `${opts.binary} run failed: ${pythonStrip(started.stderr.slice(-STDERR_EXCERPT_CHARS))}`,
      );
    }
    let state: Awaited<ReturnType<CodingAgentTarget["docker"]>>;
    try {
      state = await this.docker([
        ...cli,
        "inspect",
        "-f",
        "{{.State.Running}}",
        name,
      ]);
    } catch (error) {
      await this.dropContainer();
      throw error;
    }
    if (state.returncode !== 0 || pythonStrip(state.stdout) !== "true") {
      await this.dropContainer();
      const detail =
        pythonStrip(state.stderr.slice(-STDERR_EXCERPT_CHARS)) ||
        pythonStrip(state.stdout.slice(-STDERR_EXCERPT_CHARS));
      throw new CodingAgentUnavailableError(
        "cli.container_start",
        `${opts.binary} run exited successfully but container ${name} was not running${detail ? `: ${detail}` : ""}`,
      );
    }
    return name;
  }

  /** Unregister and remove this target's current container. */
  private async dropContainer(): Promise<void> {
    const name = this.containerName;
    this.containerName = null;
    const live = name ? unregister(name) : null;
    if (name && live)
      await removeContainersAsync(live.binary, live.context, [name]);
  }

  private ensureWorkdir(): string {
    if (this.currentWorkdir !== null) return this.currentWorkdir;
    const root = mkdtempSync(join(tmpdir(), `evaluatorq-${this.agent}-`));
    const dst = this.container ? join(root, "work") : root;
    if (this.container) {
      mkdirSync(dst);
      mkdirSync(join(root, "home"));
      mkdirSync(join(root, "lease"));
    }
    try {
      if (this.sourceWorkdir !== null)
        cpSync(this.sourceWorkdir, dst, {
          recursive: true,
          verbatimSymlinks: true,
          force: true,
        });
      const skillsDir = join(dst, this.spec.skillsDir);
      if (!isRelativeTo(resolveLoose(skillsDir), resolveLoose(dst)))
        throw new Error(
          `${this.spec.skillsDir} in the workdir is a symlink that leaves the private copy; ` +
            "refusing to write skill links through it",
        );
      mkdirSync(skillsDir, { recursive: true });
      for (const skill of this.skills) {
        const name = basename(resolve(skill));
        const link = join(skillsDir, name);
        if (pathExists(link))
          throw new Error(
            `skill ${pyRepr(name)} already exists in ${skillsDir}; refusing to shadow it`,
          );
        const target = resolveLoose(resolve(skill));
        if (this.container)
          cpSync(target, link, { recursive: true, verbatimSymlinks: true });
        else symlinkSync(target, link, "dir");
      }
    } catch (error) {
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
    if (!this.keepWorkdir)
      workdirRegistry.register(this, root, this.finalizerToken);
    this.root = root;
    this.currentWorkdir = dst;
    return dst;
  }

  newInstance(): CodingAgentTarget {
    return new CodingAgentTarget(this.agent, this.options);
  }

  /** Kill a live process group and release the temp workdir. Idempotent. */
  async close(): Promise<void> {
    if (this.proc) {
      killGroup(this.proc);
      this.proc = null;
    }
    if (this.container) await this.dropContainer();
    if (this.root === null) return;
    const lease = join(this.root, "lease");
    if (existsSync(lease)) rmSync(lease, { recursive: true, force: true });
    if (this.keepWorkdir)
      console.error(
        `CodingAgentTarget(${this.agent}): keeping workdir ${this.currentWorkdir}`,
      );
    else rmSync(this.root, { recursive: true, force: true });
    workdirRegistry.unregister(this.finalizerToken);
    containerRegistry.unregister(this.finalizerToken);
    this.currentWorkdir = null;
    this.root = null;
  }

  override async getAgentContext(): Promise<AgentContext> {
    return AgentContextSchema.parse({
      key: `coding-agent:${this.agent}`,
      systemPrompt: this.systemPrompt ?? "",
      tools: [
        ...this.spec.tools.map((name) => ({ name })),
        ...this.skills.map((skill) => ({
          name: basename(resolve(skill)),
          actionType: "skill",
        })),
      ],
      model: this.model,
    });
  }

  override mapError(error: unknown): { code: string; message: string } | null {
    if (error instanceof CodingAgentError) {
      const failure = error as unknown as FailureFields;
      return { code: failure.code, message: failure.detail };
    }
    return null;
  }

  async respond(
    messages: Message[],
    options: { signal?: AbortSignal } = {},
  ): Promise<AgentResponse> {
    const signal = options.signal;
    if (signal?.aborted) throw abortError(signal);
    const workdir = this.ensureWorkdir();
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env))
      if (value !== undefined) env[key] = value;
    Object.assign(env, this.env);
    const hostBinary = this.container
      ? null
      : codingAgentRuntime.which(
          this.launcher === "orq" ? "orq" : this.spec.binary,
          env.PATH,
        );
    const inlineSystem =
      this.spec.systemPromptFlag === null ||
      (hostBinary !== null && isBatchLauncher(hostBinary));
    const prompt = renderPrompt(messages, {
      systemPrompt: this.systemPrompt,
      inlineSystem,
    });
    let [argv, stdinText] = buildArgv({
      agent: this.agent,
      launcher: this.launcher,
      model: this.model,
      permissionMode: this.permissionMode,
      systemPrompt: inlineSystem ? null : this.systemPrompt,
      extraArgs: this.extraArgs,
      orq: this.orq,
      prompt,
    });
    if (hostBinary !== null) argv = [hostBinary, ...argv.slice(1)];
    const agentBinary = argv[0] as string;
    let name: string | null = null;
    if (this.container) {
      const root = this.root;
      if (root === null)
        throw new Error("container workdir root was not initialized");
      name = await this.ensureContainer(root);
      if (signal?.aborted) {
        await this.dropContainer();
        throw abortError(signal);
      }
      argv = buildExecArgv(this.container, {
        name,
        envNames: this.forwardEnv,
        agentArgv: argv,
      });
    }
    return withLlmSpan(
      {
        model: this.model || this.agent,
        operation: "chat",
        inputMessages: messages.map(toChatCompletion),
        attributes: {
          "orq.redteam.llm_purpose": "target",
          "evaluatorq.coding_agent.agent": this.agent,
          "evaluatorq.coding_agent.launcher": this.launcher,
        },
      },
      async (span) => {
        let succeeded = false;
        try {
          if (this.container)
            setSpanAttrs(span, {
              "evaluatorq.coding_agent.container.image": this.container.image,
              "evaluatorq.coding_agent.container.name": name,
              "evaluatorq.coding_agent.container.restarts": this.restarts,
            });
          const [returncode, stdout, stderr] = await this.run(
            argv,
            stdinText,
            workdir,
            env,
            signal,
          );
          setSpanAttrs(span, {
            "evaluatorq.coding_agent.exit_code": returncode,
          });
          const stderrExcerpt = stderr.slice(-STDERR_EXCERPT_CHARS);
          if (this.container && (returncode === 126 || returncode === 127))
            throw new CodingAgentUnavailableError(
              "cli.agent_not_found",
              `${pyRepr(agentBinary)} or evq-entrypoint is missing from image ${pyRepr(this.container.image)}: ${stderrExcerpt}`,
            );
          if (this.container && returncode === 137) {
            logKill(
              this.agent,
              "container_lost",
              `container ${name} was removed while the agent ran`,
            );
            await this.dropContainer();
            setSpanAttrs(span, {
              "evaluatorq.coding_agent.kill_reason": "container_lost",
            });
            throw new CodingAgentUnavailableError(
              "cli.timeout",
              "the container was removed while the agent was running",
              { killReason: "container_lost" },
            );
          }
          if (returncode !== 0)
            throw new CodingAgentError(
              `cli.exit.${returncode}`,
              `${argv[0]} exited ${returncode}: ${stderrExcerpt}`,
            );
          const events = parseJsonl(stdout);
          if (pythonStrip(stdout) && !events.length)
            throw new CodingAgentError(
              "cli.parse_error",
              `no JSON events in stdout: ${stdout.slice(0, STDERR_EXCERPT_CHARS)}`,
            );
          let turn: ParsedTurn;
          try {
            turn = parseEvents(this.agent, events);
          } catch (error) {
            throw new CodingAgentError(
              "cli.parse_error",
              `could not parse ${this.agent} output: ${String(error)}`,
            );
          }
          if (turn.agentError !== null)
            throw new CodingAgentError(
              "cli.agent_error",
              pythonStrip(`${turn.agentError} ${stderrExcerpt}`),
            );
          if (turn.text === null || !pythonStrip(turn.text))
            throw new CodingAgentError(
              "cli.no_result",
              `exit 0 but no final assistant message: ${stderrExcerpt}`,
            );
          if (turn.usage === null)
            console.warn(
              `CodingAgentTarget(${this.agent}): no usage in output; usage is None`,
            );
          else
            recordTokenUsage(span, {
              usage: turn.usage,
              totalCost: turn.costUsd,
            });
          setSpanAttrs(span, {
            "evaluatorq.coding_agent.cost_usd": turn.costUsd,
            "gen_ai.response.id": turn.sessionId,
          });
          const text: TextOutputItem = TextOutputItemSchema.parse({
            type: "output_text",
            text: turn.text,
            annotations: [],
          });
          const response = new AgentResponse({
            output: [...turn.toolCalls, text],
            usage: turn.usage,
            model: turn.model || this.model,
            responseId: turn.sessionId,
          });
          succeeded = true;
          return response;
        } catch (error) {
          const killReason =
            error instanceof CodingAgentError
              ? (error as unknown as FailureFields).killReason
              : signal?.aborted
                ? "cancelled"
                : undefined;
          if (killReason !== undefined)
            setSpanAttrs(span, {
              "evaluatorq.coding_agent.kill_reason": killReason,
            });
          throw error;
        } finally {
          if (!succeeded && this.container) await this.dropContainer();
        }
      },
    );
  }

  /**
   * Run one agent process; end it on the idle limit, the hard cap, an error or cancellation.
   * Output on either stream resets the idle deadline.
   */
  private run(
    argv: string[],
    stdinText: string | null,
    cwd: string,
    env: Record<string, string>,
    signal: AbortSignal | undefined,
  ): Promise<RunResult> {
    refuseUnsafeBatchArgs(argv);
    const [command, ...rest] = argv;
    let proc: ChildProcess;
    try {
      proc = spawn(command as string, rest, {
        cwd,
        env,
        stdio: [stdinText !== null ? "pipe" : "ignore", "pipe", "pipe"],
        detached: codingAgentRuntime.platform() !== "win32",
        windowsHide: true,
      });
    } catch (error) {
      throw this.spawnFailure(error, command as string);
    }
    this.proc = proc;
    const idleS = this.timeoutMs / 1000,
      hardS = this.maxTurnMs / 1000;
    const started = codingAgentRuntime.monotonic();
    let activity = started;
    const stdoutChunks: Buffer[] = [];
    let stdoutText: string | null = null;
    const stdoutSoFar = () => {
      stdoutText ??= Buffer.concat(stdoutChunks).toString("utf8");
      return stdoutText;
    };
    let stderrTail = Buffer.alloc(0);
    const keep = STDERR_EXCERPT_CHARS * 4;
    return new Promise<RunResult>((done, fail) => {
      let settled = false,
        timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error: unknown, result?: RunResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (error !== undefined) killGroup(proc, { force: true });
        this.proc = null;
        if (error !== undefined) fail(error);
        else done(result as RunResult);
      };
      const check = () => {
        const expired = deadlineError(
          this.agent,
          stdoutSoFar(),
          started,
          activity,
          idleS,
          hardS,
          codingAgentRuntime.monotonic(),
        );
        if (expired) return finish(expired);
        schedule();
      };
      const schedule = () => {
        clearTimeout(timer);
        const wait =
          Math.min(activity + idleS, started + hardS) -
          codingAgentRuntime.monotonic();
        timer = setTimeout(check, Math.max(0, wait * 1000) + 5);
      };
      const onAbort = () => {
        logKill(this.agent, "cancelled", "the caller cancelled the turn");
        finish(abortError(signal as AbortSignal));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      proc.stdout?.on("data", (chunk: Buffer) => {
        stdoutChunks.push(chunk);
        stdoutText = null;
        activity = codingAgentRuntime.monotonic();
      });
      proc.stderr?.on("data", (chunk: Buffer) => {
        stderrTail = Buffer.concat([stderrTail, chunk]);
        if (stderrTail.length > keep)
          stderrTail = stderrTail.subarray(stderrTail.length - keep);
        activity = codingAgentRuntime.monotonic();
      });
      proc.on("error", (error) =>
        finish(this.spawnFailure(error, command as string)),
      );
      proc.on("close", (code, killSignal) => {
        const expired = deadlineError(
          this.agent,
          stdoutSoFar(),
          started,
          activity,
          idleS,
          hardS,
          codingAgentRuntime.monotonic(),
        );
        if (expired) return finish(expired);
        finish(undefined, [
          returnCode(code, killSignal),
          stdoutSoFar(),
          stderrTail.toString("utf8"),
        ]);
      });
      if (stdinText !== null && proc.stdin) {
        proc.stdin.on("error", () => {});
        proc.stdin.end(stdinText);
      }
      schedule();
    });
  }

  private spawnFailure(error: unknown, command: string): unknown {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT")
      return new CodingAgentUnavailableError(
        "cli.not_found",
        `${pyRepr(command)} not found on PATH`,
      );
    if (code === "E2BIG")
      return new CodingAgentUnavailableError(
        "cli.prompt_too_long",
        `${command} argv exceeds the OS limit; the rendered transcript is too long`,
      );
    return error;
  }
}
