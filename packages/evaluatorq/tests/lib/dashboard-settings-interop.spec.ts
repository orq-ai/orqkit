import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  DashboardSettings,
  loadDashboardSettings,
  saveDashboardSettings,
} from "../../src/lib/trace-finder/settings.js";

const goldenPath = join(
  import.meta.dir,
  "fixtures",
  "dashboard-settings-python-golden.json",
);
const golden = await readFile(goldenPath, "utf8");
const dir = async () =>
  resolve(await mkdtemp(join(tmpdir(), "eq-settings-interop-")));

const authored = () =>
  new DashboardSettings({
    fastModel: "openai/gpt-5-mini",
    modelOverrides: { "finder.compiler": "x/y" },
    windowDays: 14,
    filterSelection: "llm",
    orqAuthMethod: "cli_profile",
    orqProfile: "work é",
    explorerColumns: ["trace", "cost"],
    compressionInspectorEnabled: true,
  });

describe("dashboard settings interop with Python", () => {
  test("loads a Python-written settings file", async () => {
    const values = (await loadDashboardSettings(goldenPath)).toJSON();
    expect(values.fastModel).toBe("openai/gpt-5-mini");
    expect(values.modelOverrides).toEqual({ "finder.compiler": "x/y" });
    expect(values.orqProfile).toBe("work é");
    expect(values.explorerColumns).toEqual(["trace", "cost"]);
  });

  test("writes the same bytes Python's save_settings writes", async () => {
    const path = join(await dir(), "settings.json");
    await saveDashboardSettings(authored(), path);
    expect(await readFile(path, "utf8")).toBe(golden);
  });

  test("patches an existing file without leaving camelCase keys", async () => {
    const path = join(await dir(), "settings.json");
    await writeFile(path, golden);
    const loaded = await loadDashboardSettings(path);
    await saveDashboardSettings(
      new DashboardSettings({ ...loaded.toJSON(), windowDays: 3 }),
      path,
      { changedFields: new Set(["windowDays"]) },
    );
    const written = JSON.parse(await readFile(path, "utf8"));
    expect(written.window_days).toBe(3);
    expect(Object.keys(written).sort()).toEqual(
      Object.keys(JSON.parse(golden)).sort(),
    );
  });

  test("still reads a camelCase settings file", async () => {
    const path = join(await dir(), "camel.json");
    await writeFile(
      path,
      JSON.stringify({ schemaVersion: 1, fastModel: "a/b", windowDays: 9 }),
    );
    const values = (await loadDashboardSettings(path)).toJSON();
    expect(values.fastModel).toBe("a/b");
    expect(values.windowDays).toBe(9);
  });
});
