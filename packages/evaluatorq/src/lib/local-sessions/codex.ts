import { stat } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";

import { toolResultToText } from "../common/messages.js";
import {
  assistantText,
  blocksText,
  compactionSummary,
  functionCall,
  functionCallOutput,
  reasoning,
  systemText,
  trimToolText,
  userText,
} from "./items.js";
import {
  parseSession,
  readRecords,
  type SessionRecord,
  summarizeSession,
} from "./jsonl.js";
import type { SessionSummary } from "./models.js";
import { codexHome } from "./roots.js";

const injected = [
  "<environment_context>",
  "# AGENTS.md instructions",
  "<recommended_plugins>",
  "<system_instruction>",
  "<subagent_notification>",
  "<turn_aborted>",
  "# Context from my IDE",
  "<user_instructions>",
];
const payload = (record: SessionRecord): SessionRecord =>
  record.payload &&
  typeof record.payload === "object" &&
  !Array.isArray(record.payload)
    ? (record.payload as SessionRecord)
    : {};
const isInjected = (text: string) =>
  injected.some((prefix) => text.trimStart().startsWith(prefix));
export function codexCallFailed(text: string): boolean {
  if (text.split("\n", 1)[0]?.trim() === "Script failed") return true;
  return [...text.slice(0, 600).matchAll(/^Exit code: (\d+)\r?$/gm)].some(
    (match) => Number(match[1]) !== 0,
  );
}
export function isCodexSessionPath(path: string, root: string): boolean {
  const name = basename(path);
  if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) return false;
  const parent = relative(root, dirname(path));
  if (!parent) return true;
  return (
    !parent.startsWith(`..${sep}`) &&
    parent !== ".." &&
    parent.split(sep).length === 3
  );
}
async function titleFor(id: string): Promise<string> {
  try {
    const path = join(codexHome(), "session_index.jsonl");
    await stat(path);
    const { records } = await readRecords(path);
    let title = "";
    for (const record of records)
      if (record.id === id && typeof record.thread_name === "string")
        title = record.thread_name;
    return title;
  } catch {
    return "";
  }
}
export async function summarizeCodex(
  path: string,
): Promise<SessionSummary | null> {
  return summarizeSession(path, async (head) => {
    if (head[0]?.type !== "session_meta") return null;
    const meta = payload(head[0]),
      source = meta.source;
    if (
      (source && typeof source === "object" && "subagent" in source) ||
      meta.parent_thread_id
    )
      return null;
    let prompt = "";
    for (const record of head) {
      const item = payload(record);
      if (
        record.type === "response_item" &&
        item.type === "message" &&
        item.role === "user"
      ) {
        const text = blocksText(item.content);
        if (!isInjected(text)) {
          prompt = text;
          break;
        }
      }
    }
    const id = typeof meta.id === "string" ? meta.id : "";
    return {
      source: "codex",
      sessionId: id,
      title: id ? await titleFor(id) : "",
      projectDir: typeof meta.cwd === "string" ? meta.cwd : "",
      started: meta.timestamp,
      firstPrompt: prompt,
      agentVersion:
        typeof meta.cli_version === "string" ? meta.cli_version : "",
    };
  });
}
export function mapCodexRecords(records: readonly SessionRecord[]): {
  items: Record<string, unknown>[];
  model: string;
  totalTokens: number | null;
} {
  const items: Record<string, unknown>[] = [],
    skipped: Record<string, number> = {};
  let model = "",
    totalTokens: number | null = null;
  for (const record of records) {
    const value = payload(record),
      kind = value.type;
    if (
      record.type === "turn_context" &&
      typeof value.model === "string" &&
      value.model
    )
      model = value.model;
    else if (record.type === "compacted")
      items.push(
        compactionSummary(
          typeof value.message === "string" ? value.message : "",
        ),
      );
    else if (record.type === "event_msg" && kind === "token_count") {
      const info =
          value.info && typeof value.info === "object"
            ? (value.info as SessionRecord)
            : {},
        usage =
          info.total_token_usage && typeof info.total_token_usage === "object"
            ? (info.total_token_usage as SessionRecord)
            : {};
      if (
        typeof usage.total_tokens === "number" &&
        Number.isInteger(usage.total_tokens)
      )
        totalTokens = usage.total_tokens;
    } else if (record.type === "response_item") {
      const callId = value.call_id,
        name = value.name;
      if (kind === "message") {
        const text = blocksText(value.content);
        if (value.role === "user" && text && !isInjected(text))
          items.push(userText(text));
        else if (value.role === "assistant" && text)
          items.push(assistantText(text));
      } else if (kind === "reasoning") {
        const text = Array.isArray(value.summary)
          ? value.summary
              .flatMap((part) =>
                part && typeof part.text === "string" ? [part.text] : [],
              )
              .join("\n")
          : "";
        if (text) items.push(reasoning(text));
      } else if (kind === "agent_message") {
        const text = blocksText(
          Array.isArray(value.content)
            ? value.content.filter(
                (block) => block && block.type === "input_text",
              )
            : [],
        );
        if (text)
          items.push(
            systemText(
              trimToolText(
                `${typeof value.author === "string" && value.author ? `Message from subagent ${value.author}:` : "Message from subagent:"}\n${text}`,
              ),
            ),
          );
      } else if (
        kind === "function_call" &&
        typeof callId === "string" &&
        typeof name === "string"
      )
        items.push(functionCall(callId, name, value.arguments));
      else if (
        kind === "custom_tool_call" &&
        typeof callId === "string" &&
        typeof name === "string"
      )
        items.push(functionCall(callId, name, { input: value.input }));
      else if (
        (kind === "function_call_output" ||
          kind === "custom_tool_call_output") &&
        typeof callId === "string"
      ) {
        const text =
          typeof value.output === "string"
            ? value.output
            : value.output == null
              ? ""
              : toolResultToText(value.output);
        items.push(functionCallOutput(callId, text, codexCallFailed(text)));
      } else {
        const key = typeof kind === "string" ? kind : "unknown";
        skipped[key] = (skipped[key] ?? 0) + 1;
      }
    }
  }
  if (Object.keys(skipped).length)
    console.warn(`Skipped Codex item types ${JSON.stringify(skipped)}`);
  return { items, model, totalTokens };
}
export async function parseCodex(path: string, summary: SessionSummary) {
  return parseSession(path, summary, mapCodexRecords);
}
