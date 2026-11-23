import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { SessionFamily } from "./models.js";

export function claudeDesktopDir(): string {
  if (process.platform === "darwin")
    return join(homedir(), "Library", "Application Support", "Claude");
  if (process.platform === "win32")
    return join(
      process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
      "Claude",
    );
  return join(homedir(), ".config", "Claude");
}
export function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}
export async function sessionRoots(family: SessionFamily): Promise<string[]> {
  const candidates =
    family === "claude"
      ? [
          join(
            process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
            "projects",
          ),
          join(claudeDesktopDir(), "local-agent-mode-sessions"),
        ]
      : family === "codex"
        ? [
            join(codexHome(), "sessions"),
            join(codexHome(), "archived_sessions"),
          ]
        : [
            join(
              process.env.PI_CODING_AGENT_DIR ||
                join(homedir(), ".omp", "agent"),
              "sessions",
            ),
          ];
  const exists = await Promise.all(
    candidates.map(async (path) => {
      try {
        return (await stat(path)).isDirectory();
      } catch {
        return false;
      }
    }),
  );
  return candidates.filter((_, index) => exists[index]);
}
