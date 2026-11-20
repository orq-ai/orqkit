import { envRaw } from "../../common/env-config.js";
import { setupOrqClient } from "../../common/fetch-data.js";
import { getField } from "../../common/fields.js";
import { extractStatusCode } from "../../common/target-call.js";
import { resolveOrqHost } from "./defaults.js";
import type { AgentInfoSnapshot } from "./run-store.js";

const text = (value: unknown): string | null =>
  typeof value === "string" && value ? value : null;
function field(value: unknown, camel: string, snake?: string): unknown {
  return getField(value, camel) ?? (snake ? getField(value, snake) : undefined);
}
function names(value: unknown, key: string, snakeKey?: string): string[] {
  return Array.isArray(value)
    ? value
        .map((item) =>
          text(typeof item === "string" ? item : field(item, key, snakeKey)),
        )
        .filter((name): name is string => name !== null)
    : [];
}
export function agentInfoFromResponse(
  raw: unknown,
  agentKey: string,
  options: { baseUrl?: string; workspaceKey?: string | null } = {},
): AgentInfoSnapshot {
  const baseUrl = (options.baseUrl ?? resolveOrqHost()).replace(/\/+$/, "");
  const workspace = options.workspaceKey ?? envRaw("ORQ_WORKSPACE");
  const workspaceKey =
    workspace &&
    !/^(?:urn:uuid:)?\{?[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\}?$/i.test(
      workspace,
    )
      ? workspace
      : null;
  const id = text(field(raw, "_id")) ?? text(field(raw, "id"));
  const tools = field(field(raw, "settings"), "tools");
  return {
    key: agentKey,
    id,
    role: text(field(raw, "role")),
    description: text(field(raw, "description")),
    model: text(field(field(raw, "model"), "id")),
    version:
      text(field(raw, "version")) ??
      text(field(raw, "versionHash", "version_hash")),
    tools: Array.isArray(tools)
      ? tools
          .map(
            (tool) =>
              text(field(tool, "displayName", "display_name")) ??
              text(field(tool, "key")),
          )
          .filter((name): name is string => name !== null)
      : [],
    skills: Array.isArray(field(raw, "skills"))
      ? (field(raw, "skills") as unknown[]).filter(
          (value): value is string => typeof value === "string",
        )
      : [],
    knowledgeBases: names(
      field(raw, "knowledgeBases", "knowledge_bases"),
      "knowledgeId",
      "knowledge_id",
    ),
    memoryStores: names(field(raw, "memoryStores", "memory_stores"), "key"),
    subAgents: names(field(raw, "teamOfAgents", "team_of_agents"), "key"),
    agentType: text(field(raw, "type")),
    engine: text(field(raw, "engine")),
    workspaceId: text(field(raw, "workspaceId", "workspace_id")),
    workspaceKey,
    baseUrl,
    url: id && workspaceKey ? `${baseUrl}/${workspaceKey}/agents/${id}` : null,
  };
}
export async function fetchAgentInfo(
  agentKey: string,
): Promise<AgentInfoSnapshot | null> {
  const key = envRaw("ORQ_API_KEY");
  if (!key) return null;
  try {
    const client = await setupOrqClient(key);
    return agentInfoFromResponse(
      await client.agents.retrieve(agentKey, { timeoutMs: 5000 }),
      agentKey,
    );
  } catch (error) {
    const status = extractStatusCode(error);
    const log = status === 404 ? console.error : console.warn;
    log(
      `Skipping agent_info for '${agentKey}': ${error instanceof Error ? error.name : "unknown"} (status=${status})`,
    );
    return null;
  }
}
