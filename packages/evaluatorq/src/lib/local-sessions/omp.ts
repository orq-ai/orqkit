import { dirname } from "node:path";

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
import { parseSession, type SessionRecord, summarizeSession } from "./jsonl.js";
import type { SessionSummary } from "./models.js";

const obj = (value: unknown): SessionRecord =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as SessionRecord)
    : {};
const dropped = new Set([
  "title",
  "session",
  "custom",
  "model_usage",
  "mode_change",
  "ttsr_injection",
  "model_change",
  "thinking_level_change",
  "title_change",
  "credential_pin",
]);
export function isOmpSessionPath(path: string, root: string): boolean {
  return path.endsWith(".jsonl") && dirname(dirname(path)) === root;
}
export async function summarizeOmp(
  path: string,
): Promise<SessionSummary | null> {
  return summarizeSession(path, (head) => {
    const session = head
      .slice(0, 2)
      .find((record) => record.type === "session");
    if (!session || session.parentSession) return null;
    const prompt =
      head
        .flatMap((record) =>
          record.type === "message" && obj(record.message).role === "user"
            ? [blocksText(obj(record.message).content)]
            : [],
        )
        .find(Boolean) ?? "";
    const title =
      head[0]?.type === "title" &&
      typeof head[0].title === "string" &&
      head[0].title
        ? head[0].title
        : typeof session.title === "string"
          ? session.title
          : "";
    return {
      source: "omp",
      sessionId: typeof session.id === "string" ? session.id : "",
      title,
      projectDir: typeof session.cwd === "string" ? session.cwd : "",
      started: session.timestamp,
      firstPrompt: prompt,
      agentVersion: typeof session.version === "string" ? session.version : "",
    };
  });
}
export function ompChain(records: readonly SessionRecord[]): SessionRecord[] {
  const byId = new Map<string, SessionRecord>();
  let leaf: string | null = null;
  for (const record of records)
    if (typeof record.id === "string") {
      byId.set(record.id, record);
      leaf = record.id;
    }
  const chain: SessionRecord[] = [],
    seen = new Set<string>();
  let cursor = leaf;
  while (cursor !== null && byId.has(cursor) && !seen.has(cursor)) {
    seen.add(cursor);
    const item = byId.get(cursor) as SessionRecord;
    chain.push(item);
    cursor = typeof item.parentId === "string" ? item.parentId : null;
  }
  return chain.reverse();
}
export function mapOmpRecords(records: readonly SessionRecord[]): {
  items: Record<string, unknown>[];
  model: string;
  totalTokens: number | null;
} {
  const items: Record<string, unknown>[] = [],
    skipped: Record<string, number> = {};
  let model = "",
    totalTokens: number | null = null;
  for (const record of records) {
    if (record.type === "message") {
      const message = obj(record.message),
        value = message.content;
      if (message.role === "user") {
        const text = blocksText(value);
        if (text) items.push(userText(text));
      } else if (message.role === "assistant") {
        if (typeof message.model === "string" && message.model)
          model =
            typeof message.provider === "string" && message.provider
              ? `${message.provider}/${message.model}`
              : message.model;
        const total = obj(message.usage).totalTokens;
        if (typeof total === "number" && Number.isInteger(total))
          totalTokens = (totalTokens ?? 0) + total;
        if (Array.isArray(value))
          for (const raw of value) {
            const block = obj(raw);
            if (
              block.type === "thinking" &&
              typeof block.thinking === "string" &&
              block.thinking
            )
              items.push(reasoning(block.thinking));
            else if (
              block.type === "text" &&
              typeof block.text === "string" &&
              block.text
            )
              items.push(assistantText(block.text));
            else if (
              block.type === "toolCall" &&
              typeof block.id === "string" &&
              typeof block.name === "string"
            )
              items.push(functionCall(block.id, block.name, block.arguments));
          }
      } else if (
        message.role === "toolResult" &&
        typeof message.toolCallId === "string"
      )
        items.push(
          functionCallOutput(
            message.toolCallId,
            blocksText(value),
            message.isError === true,
          ),
        );
      else if (
        message.role === "bashExecution" &&
        message.excludeFromContext !== true
      )
        items.push(
          userText(
            trimToolText(
              `$ ${typeof message.command === "string" ? message.command : ""}\n${typeof message.output === "string" ? message.output : ""}`,
            ),
          ),
        );
      else if (
        message.role !== "developer" &&
        message.role !== "bashExecution" &&
        message.role !== "toolResult"
      )
        skipped.message = (skipped.message ?? 0) + 1;
    } else if (record.type === "compaction")
      items.push(
        compactionSummary(
          typeof record.summary === "string" ? record.summary : "",
        ),
      );
    else if (record.type === "reset_boundary")
      items.push(systemText("Conversation context was reset."));
    else if (record.type === "custom_message") {
      const text = blocksText(record.content);
      if (text.trim()) {
        if (
          ["skill-prompt", "collab-prompt"].includes(String(record.customType))
        )
          items.push(userText(text));
        else if (record.display === true)
          items.push(
            systemText(trimToolText(`[${String(record.customType)}]\n${text}`)),
          );
      }
    } else if (!dropped.has(String(record.type))) {
      const key = typeof record.type === "string" ? record.type : "unknown";
      skipped[key] = (skipped[key] ?? 0) + 1;
    }
  }
  if (Object.keys(skipped).length)
    console.warn(`Skipped omp record types ${JSON.stringify(skipped)}`);
  return { items, model, totalTokens };
}
export async function parseOmp(path: string, summary: SessionSummary) {
  return parseSession(path, summary, (records) =>
    mapOmpRecords(ompChain(records)),
  );
}
