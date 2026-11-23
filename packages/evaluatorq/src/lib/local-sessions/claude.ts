import { basename, dirname, relative, sep } from "node:path";

import { toolResultToText } from "../common/messages.js";
import {
  assistantText,
  blocksText,
  compactionSummary,
  functionCall,
  functionCallOutput,
  reasoning,
  userText,
} from "./items.js";
import { parseSession, type SessionRecord, summarizeSession } from "./jsonl.js";
import type { SessionSummary } from "./models.js";

const obj = (value: unknown): SessionRecord =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as SessionRecord)
    : {};
const content = (record: SessionRecord): unknown => obj(record.message).content;
function prompt(record: SessionRecord): string | null {
  if (record.type !== "user" || record.isMeta || record.isCompactSummary)
    return null;
  const value = content(record);
  if (typeof value === "string") return value || null;
  if (
    Array.isArray(value) &&
    !value.some((block) => obj(block).type === "tool_result") &&
    value.some(
      (block) =>
        obj(block).type === "text" && typeof obj(block).text === "string",
    )
  )
    return blocksText(value);
  return null;
}
const first = (records: readonly SessionRecord[], key: string): string => {
  for (const record of records)
    if (typeof record[key] === "string" && record[key])
      return record[key] as string;
  return "";
};
export function isClaudeSessionPath(path: string, root: string): boolean {
  const parts = path.split(sep);
  if (!path.endsWith(".jsonl") || parts.includes("subagents")) return false;
  const projects = dirname(dirname(path));
  if (basename(root) === "local-agent-mode-sessions")
    return (
      basename(projects) === "projects" &&
      parts.includes(".claude") &&
      !relative(root, path).startsWith("..")
    );
  return projects === root;
}
export async function summarizeClaude(
  path: string,
): Promise<SessionSummary | null> {
  return summarizeSession(path, (head, tail) => {
    if (
      ![...head, ...tail].some(
        (record) =>
          ["user", "assistant"].includes(String(record.type)) &&
          record.isSidechain !== true,
      )
    )
      return null;
    const last = (kind: string, key: string) =>
      [...tail]
        .reverse()
        .find(
          (record) =>
            record.type === kind &&
            typeof record[key] === "string" &&
            record[key],
        )?.[key] as string | undefined;
    return {
      source: [...head, ...tail].some((record) =>
        ["claude-desktop", "local-agent"].includes(String(record.entrypoint)),
      )
        ? "claude-desktop"
        : "claude-code",
      sessionId: first(head, "sessionId"),
      title:
        last("custom-title", "customTitle") ||
        last("ai-title", "aiTitle") ||
        "",
      projectDir: first(head, "cwd"),
      started: first(head, "timestamp"),
      firstPrompt: head.map(prompt).find(Boolean) || "",
      agentVersion: first(head, "version"),
    };
  });
}
function parentOf(record: SessionRecord): string | null {
  if (typeof record.parentUuid === "string") return record.parentUuid;
  if (
    record.type === "system" &&
    record.parentUuid == null &&
    typeof record.logicalParentUuid === "string"
  )
    return record.logicalParentUuid;
  return null;
}
export function activeClaudeBranch(
  records: readonly SessionRecord[],
): SessionRecord[] {
  const index = new Map<string, number>();
  records.forEach((record, position) => {
    if (typeof record.uuid === "string") index.set(record.uuid, position);
  });
  if (!index.size) return [];
  const children = new Map<string, string[]>(),
    roots: string[] = [];
  for (const [id, position] of index) {
    const parent = parentOf(records[position] as SessionRecord);
    if (parent !== null && index.has(parent)) {
      const list = children.get(parent) ?? [];
      list.push(id);
      children.set(parent, list);
    } else roots.push(id);
  }
  const leaf = [...records]
    .reverse()
    .find(
      (record) =>
        record.type === "last-prompt" &&
        typeof record.leafUuid === "string" &&
        index.has(record.leafUuid),
    )?.leafUuid;
  let cursor: string | null =
    typeof leaf === "string"
      ? leaf
      : [...index].reduce((a, b) => (a[1] > b[1] ? a : b))[0];
  const ancestors = new Set<string>();
  while (cursor !== null && index.has(cursor) && !ancestors.has(cursor)) {
    ancestors.add(cursor);
    cursor = parentOf(records[index.get(cursor) as number] as SessionRecord);
  }
  const hasPrompt = new Map<string, boolean>(),
    lastPosition = new Map<string, number>();
  for (const root of roots) {
    const stack: [string, boolean][] = [[root, false]];
    while (stack.length) {
      const [id, done] = stack.pop() as [string, boolean],
        kids = children.get(id) ?? [];
      if (!done) {
        stack.push(
          [id, true],
          ...kids.map((kid): [string, boolean] => [kid, false]),
        );
        continue;
      }
      hasPrompt.set(
        id,
        prompt(records[index.get(id) as number] as SessionRecord) !== null ||
          kids.some((kid) => hasPrompt.get(kid)),
      );
      lastPosition.set(
        id,
        Math.max(
          index.get(id) as number,
          ...kids.map((kid) => lastPosition.get(kid) as number),
        ),
      );
    }
  }
  const kept = new Set<string>(),
    walk = [...roots];
  while (walk.length) {
    const id = walk.pop() as string;
    kept.add(id);
    let kids = children.get(id) ?? [];
    const branches = kids.filter((kid) => hasPrompt.get(kid));
    if (branches.length >= 2) {
      const chosen =
        branches.find((kid) => ancestors.has(kid)) ??
        branches.reduce((a, b) =>
          (lastPosition.get(a) as number) > (lastPosition.get(b) as number)
            ? a
            : b,
        );
      kids = kids.filter((kid) => kid === chosen || !hasPrompt.get(kid));
    }
    walk.push(...kids);
  }
  return records.filter(
    (record, position) =>
      typeof record.uuid === "string" &&
      index.get(record.uuid) === position &&
      kept.has(record.uuid),
  );
}
export function mapClaudeRecords(records: readonly SessionRecord[]): {
  items: Record<string, unknown>[];
  model: string;
  totalTokens: number | null;
} {
  const items: Record<string, unknown>[] = [],
    usages = new Map<string, number>();
  let model = "";
  for (const record of records) {
    if (record.isSidechain === true) continue;
    const value = content(record);
    if (record.type === "user") {
      if (Array.isArray(value))
        for (const rawBlock of value) {
          const block = obj(rawBlock);
          if (
            block.type === "tool_result" &&
            typeof block.tool_use_id === "string"
          ) {
            const raw = block.content,
              text =
                typeof raw === "string" || Array.isArray(raw)
                  ? blocksText(raw)
                  : raw == null
                    ? ""
                    : toolResultToText(raw);
            items.push(
              functionCallOutput(
                block.tool_use_id,
                text,
                block.is_error === true,
              ),
            );
          }
        }
      if (record.isMeta) continue;
      const text =
        typeof value === "string"
          ? value
          : Array.isArray(value)
            ? blocksText(
                value.filter((block) => obj(block).type !== "tool_result"),
              )
            : "";
      if (text)
        items.push(
          record.isCompactSummary ? compactionSummary(text) : userText(text),
        );
    } else if (record.type === "assistant") {
      const message = obj(record.message);
      if (typeof message.model === "string" && message.model)
        model = message.model;
      if (message.usage && typeof message.usage === "object") {
        const usage = obj(message.usage),
          key =
            typeof message.id === "string" ? message.id : String(record.uuid);
        usages.set(
          key,
          [
            "input_tokens",
            "output_tokens",
            "cache_creation_input_tokens",
            "cache_read_input_tokens",
          ].reduce(
            (sum, name) =>
              sum +
              (typeof usage[name] === "number" && Number.isInteger(usage[name])
                ? (usage[name] as number)
                : 0),
            0,
          ),
        );
      }
      if (typeof value === "string") {
        if (value) items.push(assistantText(value));
        continue;
      }
      if (!Array.isArray(value)) continue;
      for (const rawBlock of value) {
        const block = obj(rawBlock);
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
          block.type === "tool_use" &&
          typeof block.id === "string" &&
          typeof block.name === "string"
        )
          items.push(functionCall(block.id, block.name, block.input));
      }
    }
  }
  return {
    items,
    model,
    totalTokens: usages.size
      ? [...usages.values()].reduce((a, b) => a + b, 0)
      : null,
  };
}
export async function parseClaude(path: string, summary: SessionSummary) {
  return parseSession(path, summary, (records) =>
    mapClaudeRecords(activeClaudeBranch(records)),
  );
}
