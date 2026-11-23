import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readdir,
  readFile,
  stat,
  symlink,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";

import { getStoreDir } from "../common/run-store-dir.js";
import { type InsightsRunFields, InsightsRunSchema } from "./models.js";

export function getInsightsRunsDir(): string {
  return getStoreDir("insights-runs");
}
export function insightsRunSlug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 64) || "insights"
  );
}
function code(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}
export async function saveRun(
  run: InsightsRunFields,
  runsDir = getInsightsRunsDir(),
): Promise<string> {
  const parsed = InsightsRunSchema.parse(run),
    date = new Date(parsed.createdAt);
  const stamp = date
    .toISOString()
    .slice(0, 19)
    .replace(/[-:]/g, "")
    .replace("T", "-");
  const base = `insights_${stamp}_${insightsRunSlug(parsed.runName)}`;
  await mkdir(runsDir, { recursive: true, mode: 0o700 });
  const tempName = `.${base}.${randomUUID()}.tmp`,
    temporary = join(runsDir, tempName);
  let keepTemporary = false;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      const json = JSON.stringify(
        parsed,
        function (this: Record<string, unknown>, key, serialized) {
          const original = this[key];
          return original instanceof Set ? [...original] : serialized;
        },
        2,
      );
      await file.writeFile(`${json}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    for (let suffix = 1; ; suffix++) {
      const path = join(
        runsDir,
        `${base}${suffix === 1 ? "" : `-${suffix}`}.json`,
      );
      try {
        await link(temporary, path);
        return path;
      } catch (error) {
        if (code(error) === "EEXIST") continue;
        if (
          !["EPERM", "EOPNOTSUPP", "ENOSYS", "EXDEV"].includes(
            code(error) ?? "",
          )
        )
          throw error;
        console.warn(
          `Hard links are unavailable in ${runsDir}; saving run through an atomic symlink`,
        );
        try {
          await symlink(tempName, path);
          keepTemporary = true;
          return path;
        } catch (linkError) {
          if (code(linkError) === "EEXIST") continue;
          throw linkError;
        }
      }
    }
  } finally {
    if (!keepTemporary) await unlink(temporary).catch(() => {});
  }
}
export async function loadRun(path: string): Promise<InsightsRunFields> {
  return InsightsRunSchema.parse(JSON.parse(await readFile(path, "utf8")));
}
export async function listRunPaths(
  runsDir = getInsightsRunsDir(),
): Promise<string[]> {
  try {
    const names = (await readdir(runsDir)).filter(
      (name) => name.startsWith("insights_") && name.endsWith(".json"),
    );
    const paths = await Promise.all(
      names.map(async (name) => {
        const path = join(runsDir, name);
        try {
          return { path, mtime: (await stat(path)).mtimeMs };
        } catch (error) {
          console.warn(`Could not stat Insights run ${path}: ${String(error)}`);
          return { path, mtime: 0 };
        }
      }),
    );
    return paths.sort((a, b) => b.mtime - a.mtime).map(({ path }) => path);
  } catch (error) {
    console.warn(
      `Could not list Insights run files in ${runsDir}: ${String(error)}`,
    );
    return [];
  }
}
export async function listRuns(
  runsDir = getInsightsRunsDir(),
): Promise<[string, InsightsRunFields | string][]> {
  const paths = await listRunPaths(runsDir),
    results: [string, InsightsRunFields | string][] = [];
  for (const path of paths) {
    try {
      results.push([path, await loadRun(path)]);
    } catch (error) {
      const message = `${error instanceof Error ? error.name : "Error"}: ${String(error instanceof Error ? error.message : error)}`;
      console.warn(`Unreadable Insights run ${path}: ${message}`);
      results.push([path, message]);
    }
  }
  return results;
}
