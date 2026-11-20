import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

import { DEFAULT_ORQ_BASE_URL, envRaw, envText } from "../common/env-config.js";
import { pythonStrip, SPACE } from "../common/sanitize.js";
import {
  credentialFingerprint,
  loadDashboardSettings,
} from "../trace-finder/settings.js";
import { discoverOrqScope, findOrqCli } from "./orq-scope.js";

export const DEFAULT_BASE_URL = DEFAULT_ORQ_BASE_URL;
const slugCache = new Map<string, { expires: number; slug: string | null }>();
const renderCache = new AsyncLocalStorage<
  Map<string, Promise<string | null>>
>();
export function cliSlugRenderScope<T>(render: () => T): T {
  return renderCache.run(new Map(), render);
}
export function clearCliSlugCache(): void {
  slugCache.clear();
}
async function discoverCliSlug(
  profile: string | null,
  fingerprint: string | null,
  useCliSession: boolean,
): Promise<string | null> {
  const scope = await discoverOrqScope(profile, { useCliSession }),
    slug = scope.workspaceKey;
  if (!slug)
    console.warn(
      `Could not resolve the Orq workspace slug from the CLI: ${scope.error || "the credential has no matching listed workspace"}`,
    );
  if (!useCliSession)
    slugCache.set(JSON.stringify([profile, fingerprint, false]), {
      expires: performance.now() + (slug && fingerprint ? 300000 : 30000),
      slug,
    });
  return slug;
}
async function cliSlug(
  profile: string | null,
  fingerprint: string | null,
  useCliSession = false,
): Promise<string | null> {
  const key = JSON.stringify([profile, fingerprint, useCliSession]),
    render = useCliSession ? renderCache.getStore() : undefined;
  const inRender = render?.get(key);
  if (inRender) return inRender;
  const cached = !useCliSession ? slugCache.get(key) : undefined;
  if (cached && cached.expires > performance.now()) return cached.slug;
  const pending = discoverCliSlug(profile, fingerprint, useCliSession);
  render?.set(key, pending);
  return pending;
}
export async function resolveSlug(): Promise<string | null> {
  const settings = await loadDashboardSettings();
  if (settings.orqAuthMethod === "cli_oauth" && settings.orqWorkspace)
    return settings.orqWorkspace;
  const env = envRaw("ORQ_WORKSPACE") || envRaw("ORQ_WORKSPACE_SLUG");
  if (env && pythonStrip(env)) return pythonStrip(env);
  if (!(await findOrqCli())) return null;
  if (settings.orqAuthMethod === "cli_profile" && settings.orqProfile)
    return cliSlug(settings.orqProfile, settings.orqCredentialFingerprint);
  const apiKey = envText("ORQ_API_KEY");
  if (apiKey)
    return cliSlug(null, credentialFingerprint(apiKey, envRaw("ORQ_BASE_URL")));
  return cliSlug(null, null, true);
}
export async function resolveBaseUrl(): Promise<string> {
  const saved = await loadDashboardSettings();
  const host =
    saved.orqAuthMethod === "cli_oauth"
      ? saved.orqOauthServer
      : saved.orqProfile
        ? saved.orqProfileHost
        : null;
  for (const [source, candidate] of [
    ["selected credential", host],
    ["ORQ_BASE_URL", envRaw("ORQ_BASE_URL")],
    ["default", DEFAULT_ORQ_BASE_URL],
  ]) {
    if (!candidate) continue;
    const origin = pythonStrip(candidate).replace(/\/+$/, "");
    try {
      const parsed = new URL(origin);
      if (
        /^https?:\/\/[^/?#]+$/i.test(origin) &&
        parsed.hostname &&
        parsed.port !== "0" &&
        !parsed.username &&
        !parsed.password &&
        !origin.includes("@") &&
        !new RegExp(SPACE).test(origin) &&
        !origin.includes("\\")
      )
        return origin;
    } catch {}
    console.warn(`Ignoring invalid Orq UI host origin from ${source}`);
  }
  return DEFAULT_ORQ_BASE_URL;
}
export function classifyHost(
  url: string | null | undefined,
): "Production" | "Staging" | "On-prem" {
  const host = pythonStrip(url || DEFAULT_ORQ_BASE_URL).toLowerCase();
  if (
    host.includes("my.orq.ai") &&
    !host.includes("staging") &&
    !host.includes("dev")
  )
    return "Production";
  if (
    host.includes(".orq.ai") &&
    (host.includes("staging") || host.includes("dev"))
  )
    return "Staging";
  return "On-prem";
}
