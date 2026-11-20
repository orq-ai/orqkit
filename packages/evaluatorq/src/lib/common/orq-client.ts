import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Orq } from "@orq-ai/node";

import { DEFAULT_ORQ_BASE_URL, envRaw } from "./env-config.js";

const INSTALL_HINT =
  "The @orq-ai/node package is not installed. Install it with: npm install @orq-ai/node (or: bun add @orq-ai/node)";

export function orqServerUrl(): string {
  return envRaw("ORQ_BASE_URL", DEFAULT_ORQ_BASE_URL);
}

export async function resolveOrqClient(
  apiKey?: string | null,
  baseUrl?: string | null,
): Promise<Orq> {
  const key = apiKey || envRaw("ORQ_API_KEY");
  if (!key) {
    throw new Error(
      "ORQ_API_KEY environment variable must be set to reach the Orq API.",
    );
  }
  let sdk: typeof import("@orq-ai/node");
  try {
    sdk = await import("@orq-ai/node");
  } catch (cause) {
    throw new Error(INSTALL_HINT, { cause });
  }
  return new sdk.Orq({
    apiKey: key,
    serverURL: baseUrl || orqServerUrl(),
  });
}

export interface OrqProfile {
  name: string;
  apiKey: string;
  server: string | null;
  active: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

async function storedProfileKeys(path: string): Promise<Map<string, string>> {
  const keys = new Map<string, string>();
  let stored: unknown;
  try {
    if (
      process.platform !== "win32" &&
      ((await stat(path)).mode & 0o077) !== 0
    ) {
      console.warn(
        `Orq profile credentials at ${path} are not private; run orq doctor --fix`,
      );
      return keys;
    }
    stored = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ENOENT") {
      console.warn(
        `Could not read Orq profile credentials at ${path}: ${error}`,
      );
    }
    return keys;
  }
  const rows = isRecord(stored) ? stored.profiles : null;
  if (!isRecord(rows)) {
    return keys;
  }
  for (const [name, entry] of Object.entries(rows)) {
    const key = isRecord(entry) ? entry.api_key : null;
    if (typeof key === "string" && key && !key.includes("*")) {
      keys.set(name, key);
    }
  }
  return keys;
}

interface CliOutcome {
  status: number;
  stdout: string;
  stderr: string;
}

function runProfileList(timeoutMs: number): Promise<CliOutcome | null> {
  const env = { ...process.env };
  delete env.ORQ_VERBOSE;
  delete env.ORQ_JMESPATH;
  return new Promise((resolve) => {
    execFile(
      "orq",
      ["auth", "profile", "list", "-o", "json", "--no-input"],
      { env, timeout: timeoutMs },
      (error, stdout, stderr) => {
        const code = (error as { code?: unknown } | null)?.code;
        if (code === "ENOENT") {
          resolve(null);
          return;
        }
        if (error && typeof code !== "number") {
          console.warn(
            `Could not read profiles from the installed orq CLI: ${error.message}`,
          );
          resolve(null);
          return;
        }
        resolve({
          status: typeof code === "number" ? code : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

/**
 * Profiles the installed `orq` CLI knows, or none when it is missing, fails, or
 * has no keys. The CLI masks keys in its JSON output, so masked entries are
 * resolved from its private local credential file.
 */
export async function listOrqProfiles(timeoutMs = 5000): Promise<OrqProfile[]> {
  const result = await runProfileList(timeoutMs);
  if (result === null) {
    return [];
  }
  let listing: unknown = null;
  if (result.status === 0) {
    try {
      listing = JSON.parse(result.stdout);
    } catch (error) {
      console.warn(
        `Could not read profiles from the installed orq CLI: ${error}`,
      );
      return [];
    }
  }
  const rows = isRecord(listing) ? listing.profiles : listing;
  if (!Array.isArray(rows)) {
    const detail = result.stderr.trim().slice(0, 200);
    console.warn(
      `Could not read profiles from the installed orq CLI (exit ${result.status}): ${detail || "unexpected JSON response"}`,
    );
    return [];
  }
  const stored = await storedProfileKeys(
    join(homedir(), ".orq", "credentials.json"),
  );
  const profiles: OrqProfile[] = [];
  for (const row of rows) {
    if (!isRecord(row)) {
      continue;
    }
    const { name, api_key: listedKey, server, active } = row;
    if (
      typeof name !== "string" ||
      !name ||
      typeof listedKey !== "string" ||
      !listedKey
    ) {
      continue;
    }
    const apiKey = listedKey.includes("*") ? stored.get(name) : listedKey;
    if (!apiKey) {
      console.warn(
        `Skipping Orq profile ${name} because its API key is unavailable`,
      );
      continue;
    }
    profiles.push({
      name,
      apiKey,
      server: typeof server === "string" && server ? server : null,
      active: Boolean(active),
    });
  }
  return profiles;
}
