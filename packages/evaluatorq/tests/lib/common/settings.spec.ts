import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadModelSettings } from "../../../src/lib/common/model-roles.js";
import { clearEncryptionKeyCache } from "../../../src/lib/trace-finder/secure-credentials.js";
import {
  DashboardSettings,
  effectiveDashboardSettings,
  loadDashboardSettings,
  readStoredDashboardApiKey,
  saveDashboardSettings,
  storeDashboardApiKey,
} from "../../../src/lib/trace-finder/settings.js";
import credentialGoldens from "../fixtures/credentials-python-goldens.json" with {
  type: "json",
};
import goldens from "../fixtures/settings-python-goldens.json" with {
  type: "json",
};

type Row = Record<string, unknown>;
const camel = (key: string) =>
  key.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase());
const snake = (key: string) =>
  key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const known = new Set([
  ...Object.keys(new DashboardSettings().toJSON()),
  "compilerModel",
  "applyModel",
]);
function native(value: unknown): Row {
  return Object.fromEntries(
    Object.entries(value as Row).map(([key, item]) => [
      known.has(camel(key)) ? camel(key) : key,
      item,
    ]),
  );
}
let directory: string,
  warning: ReturnType<typeof spyOn<typeof console, "warn">>,
  env: Record<string, string | undefined>;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "eq-settings-"));
  warning = spyOn(console, "warn").mockImplementation(() => {});
  env = {};
  for (const name of [
    "EVALUATORQ_FINDER_WINDOW_DAYS",
    "EVALUATORQ_FINDER_LIMIT",
    "EVALUATORQ_FINDER_PARALLELISM",
    "EVALUATORQ_DASHBOARD_KEY_ENCRYPTION_KEY",
  ]) {
    env[name] = process.env[name];
    delete process.env[name];
  }
  clearEncryptionKeyCache();
});
afterEach(async () => {
  warning.mockRestore();
  clearEncryptionKeyCache();
  for (const [name, value] of Object.entries(env))
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  await rm(directory, { recursive: true, force: true });
});
for (const row of goldens.models)
  it(`matches pinned settings validation ${row.label}`, () => {
    if (row.error) {
      expect(() => new DashboardSettings(row.raw)).toThrow();
      expect(() => new DashboardSettings(native(row.raw))).toThrow();
    } else {
      expect<unknown>(new DashboardSettings(row.raw).toJSON()).toEqual(
        row.expected,
      );
      expect<unknown>(new DashboardSettings(native(row.raw)).toJSON()).toEqual(
        row.expected,
      );
    }
  });
for (const row of goldens.loads)
  it(`matches pinned settings recovery ${row.label}`, async () => {
    const path = join(directory, "settings.json");
    await writeFile(path, JSON.stringify(row.raw));
    expect<unknown>((await loadDashboardSettings(path)).toJSON()).toEqual(
      row.expected,
    );
  });
for (const row of goldens.saves)
  it(`matches pinned save transaction ${row.label}`, async () => {
    const path = join(directory, "settings.json"),
      destination = row.copyTo ? join(directory, "copy.json") : path;
    if (row.initial !== null)
      await writeFile(path, JSON.stringify(row.initial));
    let settings =
      row.fresh !== null
        ? new DashboardSettings(row.fresh)
        : await loadDashboardSettings(path);
    if (row.runtime)
      settings = settings.withUpdates(native(row.runtime), {
        persistent: false,
      });
    if (row.updates) settings = settings.withUpdates(native(row.updates));
    if (row.direct) Object.assign(settings, native(row.direct));
    if (row.concurrent !== null)
      await writeFile(path, JSON.stringify(row.concurrent));
    expect<unknown>(settings.toJSON()).toEqual(row.before);
    const action = () =>
      saveDashboardSettings(
        settings,
        destination,
        row.changed
          ? {
              changedFields: new Set(
                row.changed.map((key) =>
                  known.has(camel(key)) ? camel(key) : key,
                ),
              ),
            }
          : {},
      );
    if (row.error) await expect(action()).rejects.toThrow();
    else await action();
    let persisted: unknown = null;
    try {
      persisted = JSON.parse(await readFile(destination, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    expect(
      persisted == null
        ? persisted
        : Array.isArray(persisted)
          ? persisted
          : native(persisted),
    ).toEqual(row.persisted);
    if (!row.error) {
      expect((await stat(destination)).mode & 0o777).toBe(0o600);
      if (persisted && !Array.isArray(persisted))
        expect(
          Object.keys(persisted as object).some(
            (key) => known.has(key) && key !== snake(key),
          ),
        ).toBe(false);
    }
  });
it("merges concurrent edits from separate readers and preserves future fields", async () => {
  const path = join(directory, "settings.json");
  await writeFile(
    path,
    JSON.stringify({
      schemaVersion: 9,
      windowDays: 7,
      limit: 500,
      modelOverrides: { "future.task": "future" },
      future_free: { free_key: 1 },
    }),
  );
  const a = await loadDashboardSettings(path),
    b = await loadDashboardSettings(path);
  await Promise.all([
    saveDashboardSettings(
      a.withUpdates({ windowDays: 12, modelOverrides: { apply: "a" } }),
      path,
    ),
    saveDashboardSettings(
      b.withUpdates({ limit: 800, modelOverrides: { "finder.compiler": "b" } }),
      path,
    ),
  ]);
  const raw = JSON.parse(await readFile(path, "utf8"));
  expect(raw.window_days).toBe(12);
  expect(raw.limit).toBe(800);
  expect(raw.schema_version).toBe(9);
  expect(raw.model_overrides).toEqual({
    "future.task": "future",
    apply: "a",
    "finder.compiler": "b",
  });
  expect(raw.future_free).toEqual({ free_key: 1 });
});
it("uses environment and explicit finder limits without persisting runtime overrides", async () => {
  const path = join(directory, "settings.json");
  await writeFile(
    path,
    JSON.stringify({
      schemaVersion: 1,
      windowDays: 8,
      limit: 700,
      parallelism: 11,
      orqWorkspace: "legacy",
      orqProjectId: "legacy-project",
    }),
  );
  process.env.EVALUATORQ_FINDER_WINDOW_DAYS = "20";
  process.env.EVALUATORQ_FINDER_LIMIT = "900";
  process.env.EVALUATORQ_FINDER_PARALLELISM = "1000";
  const effective = await effectiveDashboardSettings(
    { windowDays: 30, limit: null },
    path,
  );
  expect(effective.windowDays).toBe(30);
  expect(effective.limit).toBe(900);
  expect(effective.parallelism).toBe(11);
  expect(effective.orqWorkspace).toBeNull();
  expect(effective.orqProjectId).toBeNull();
  await saveDashboardSettings(
    effective.withUpdates({ compressionInspectorEnabled: true }),
    path,
  );
  const raw = JSON.parse(await readFile(path, "utf8"));
  expect(raw.window_days).toBe(8);
  expect(raw.limit).toBe(700);
  expect(raw.orq_workspace).toBe("legacy");
  expect(raw.compression_inspector_enabled).toBe(true);
});
it("reads canonical settings through the existing role-model resolver", async () => {
  const path = join(directory, "settings.json"),
    settings = new DashboardSettings({
      fastModel: "native-fast",
      smartModel: "native-smart",
      modelOverrides: { apply: "native-apply" },
    });
  await saveDashboardSettings(settings, path);
  expect(loadModelSettings(path)).toEqual({
    roles: { fast: "native-fast", smart: "native-smart" },
    modelOverrides: { apply: "native-apply" },
  });
  await writeFile(
    path,
    JSON.stringify({ schemaVersion: 1, fastModel: "ignored", orqProfile: 7 }),
  );
  expect(loadModelSettings(path)).toEqual({ roles: {}, modelOverrides: {} });
});
it("stores only synthetic ciphertext and safely reads it back without Keychain access", async () => {
  process.env.EVALUATORQ_DASHBOARD_KEY_ENCRYPTION_KEY =
    credentialGoldens.syntheticEncryptionKey;
  const plain = "synthetic-api-key-for-settings",
    settings = await storeDashboardApiKey(
      new DashboardSettings(),
      ` ${plain} `,
    ),
    path = join(directory, "settings.json");
  await saveDashboardSettings(settings, path);
  const text = await readFile(path, "utf8");
  expect(text).not.toContain(plain);
  expect(settings.orqAuthMethod).toBe("stored_api_key");
  expect(
    await readStoredDashboardApiKey(await loadDashboardSettings(path)),
  ).toBe(plain);
  expect(await readStoredDashboardApiKey(new DashboardSettings())).toBeNull();
});
it("never includes invalid credential values in recovery warnings", async () => {
  const path = join(directory, "settings.json");
  await writeFile(
    path,
    JSON.stringify({
      schemaVersion: 1,
      orqApiKeyCiphertext: { sensitive: "synthetic-private-marker" },
    }),
  );
  await loadDashboardSettings(path);
  expect(warning).toHaveBeenCalled();
  expect(JSON.stringify(warning.mock.calls)).not.toContain(
    "synthetic-private-marker",
  );
});
