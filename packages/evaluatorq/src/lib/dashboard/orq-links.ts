import { envRaw } from "../common/env-config.js";
import { parseHttpUrl } from "../common/reports/html-helpers.js";
import { resolveBaseUrl } from "./orq-workspace.js";

export function isStudioWorkspaceKey(
  value: string | null | undefined,
): boolean {
  if (!value) return false;
  const uuid = value
    .replaceAll("urn:", "")
    .replaceAll("uuid:", "")
    .replace(/^[{}]+|[{}]+$/g, "")
    .replaceAll("-", "");
  return !/^[a-fA-F0-9]{32}$/.test(uuid);
}
export function parseExperimentUrl(
  url: string | null | undefined,
): [string | null, string | null] {
  if (!parseHttpUrl(url)) return [null, null];
  let raw = url ?? "";
  while (raw.length && raw.charCodeAt(0) <= 32) raw = raw.slice(1);
  raw = raw.replace(/[\t\r\n]/g, "");
  const match = /^(https?):\/\/([^/?#]*)([^?#]*)/i.exec(raw);
  if (!match) return [null, null];
  const segments = (match[3] ?? "").split("/").filter(Boolean);
  if (
    segments.length >= 2 &&
    segments[1] === "experiments" &&
    isStudioWorkspaceKey(segments[0])
  )
    return [`${match[1]?.toLowerCase()}://${match[2]}`, segments[0] ?? null];
  return [null, null];
}
export function studioWorkspaceKey(
  fallback: string | null = null,
): string | null {
  const env = envRaw("ORQ_WORKSPACE");
  return isStudioWorkspaceKey(env)
    ? (env ?? null)
    : isStudioWorkspaceKey(fallback)
      ? fallback
      : null;
}
export async function orqStudioUrl(options: {
  targetKind: string | null;
  entityId: string | null;
  experimentUrl?: string | null;
  workspaceId?: string | null;
  baseUrl?: string | null;
}): Promise<string | null> {
  const entity =
    options.targetKind === "agent"
      ? "agents"
      : options.targetKind === "deployment"
        ? "deployments"
        : null;
  if (!entity || !options.entityId) return null;
  let [host, workspace] = parseExperimentUrl(options.experimentUrl);
  if (!host || !workspace) {
    workspace = studioWorkspaceKey(options.workspaceId);
    host = options.baseUrl || (await resolveBaseUrl());
  }
  if (!workspace || !host || !parseHttpUrl(host)) return null;
  return `${host.replace(/\/+$/, "")}/${workspace}/${entity}/${options.entityId}`;
}
