import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isStudioWorkspaceKey,
  orqStudioUrl,
  parseExperimentUrl,
  studioWorkspaceKey,
} from "../../../src/lib/dashboard/orq-links.js";
import {
  discoverOauthScopes,
  discoverOrqScope,
  scopeCliJson,
} from "../../../src/lib/dashboard/orq-scope.js";
import {
  classifyHost,
  clearCliSlugCache,
  cliSlugRenderScope,
  resolveBaseUrl,
  resolveSlug,
} from "../../../src/lib/dashboard/orq-workspace.js";
import {
  runTraceUrl,
  singleTraceUrl,
  threadTraceUrl,
  traceLinkButton,
  traceSpanUrl,
} from "../../../src/lib/dashboard/trace-links.js";
import goldens from "../fixtures/dashboard-links-python-goldens.json" with {
  type: "json",
};

let directory: string, original: NodeJS.ProcessEnv;
beforeEach(async () => {
  original = { ...process.env };
  directory = await mkdtemp(join(tmpdir(), "eq-dashboard-links-"));
  for (const key of Object.keys(process.env))
    if (key.startsWith("ORQ_") || key.startsWith("EVALUATORQ_"))
      delete process.env[key];
  process.env.EVALUATORQ_DASHBOARD_SETTINGS = join(directory, "settings.json");
  clearCliSlugCache();
});
afterEach(async () => {
  for (const key of Object.keys(process.env))
    if (!Object.hasOwn(original, key)) delete process.env[key];
  Object.assign(process.env, original);
  clearCliSlugCache();
  await rm(directory, { recursive: true, force: true });
});
const selectedNames = [
  "ORQ_API_KEY",
  "ORQ_BASE_URL",
  "ORQ_SERVER",
  "ORQ_WORKSPACE",
  "ORQ_WORKSPACE_SLUG",
  "ORQ_PROJECT",
  "ORQ_VERBOSE",
  "ORQ_JMESPATH",
];
async function fakeCli(responses: unknown[]): Promise<void> {
  await writeFile(join(directory, "responses.json"), JSON.stringify(responses));
  await writeFile(join(directory, "state.json"), "0");
  const script = `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const dir = __dirname, index = Number(fs.readFileSync(path.join(dir,"state.json"),"utf8"));
fs.writeFileSync(path.join(dir,"state.json"), String(index+1));
const row = {args: process.argv.slice(2), env: Object.fromEntries(${JSON.stringify(selectedNames)}.map(k => [k,process.env[k] ?? null]))};
fs.appendFileSync(path.join(dir,"calls.jsonl"), JSON.stringify(row)+"\\n");
const response = JSON.parse(fs.readFileSync(path.join(dir,"responses.json"),"utf8"))[index];
if (response === "failed") process.exit(1);
if (response === "invalid-json") process.stdout.write("not json");
else if (response === "hang") setTimeout(()=>{},10000);
else process.stdout.write(JSON.stringify(response));
`;
  await writeFile(join(directory, "orq"), script);
  await chmod(join(directory, "orq"), 0o700);
  process.env.PATH = `${directory}:${original.PATH ?? ""}`;
}
const calls = async (): Promise<unknown[]> =>
  (await readFile(join(directory, "calls.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

describe("credential scope matches pinned Python", () => {
  test("proxy-only environment credentials do not start the CLI without a platform host", async () => {
    process.env.ROUTER_BASE_URL = "https://proxy.example/custom";
    process.env.ORQ_API_KEY = "test-key";
    await fakeCli([{}]);
    await expect(
      scopeCliJson(["projects", "list"], { profile: null, timeoutMs: 1000 }),
    ).rejects.toThrow("set ORQ_BASE_URL explicitly");
    expect(await readFile(join(directory, "state.json"), "utf8")).toBe("0");
    await scopeCliJson(["projects", "list"], {
      profile: null,
      server: "https://explicit.example",
      timeoutMs: 1000,
    });
    expect(await calls()).toMatchObject([
      { env: { ORQ_SERVER: "https://explicit.example" } },
    ]);
  });

  for (const row of goldens.scenarios)
    test(row.name, async () => {
      Object.assign(process.env, row.env);
      await fakeCli(row.responses);
      const result =
        row.oauth === null
          ? await discoverOrqScope(row.profile, { useCliSession: row.session })
          : await discoverOauthScopes(row.oauth, { workspace: row.workspace });
      expect(result).toEqual(row.expected);
      expect(await calls()).toEqual(row.calls);
    });
  test("missing CLI and timed out CLI return no scope without leaking credentials", async () => {
    process.env.PATH = directory;
    expect((await discoverOrqScope()).error).toBe(
      "The orq CLI could not list projects for this credential.",
    );
    await fakeCli(["hang"]);
    expect(
      await scopeCliJson(["projects", "list"], {
        profile: null,
        timeoutMs: 25,
      }),
    ).toBeNull();
  });
});
describe("report links match pinned Python", () => {
  for (const [i, row] of goldens.links.entries())
    test(`links ${i}`, async () => {
      process.env.ORQ_WORKSPACE = "env-slug";
      process.env.ORQ_BASE_URL = "https://fallback.example";
      process.env.PATH = directory;
      expect(Array.from(parseExperimentUrl(row.url))).toEqual(row.parse);
      expect(await threadTraceUrl(row.value, row.url)).toBe(row.thread);
      expect(await singleTraceUrl(row.value, row.url)).toBe(row.single);
      expect(await runTraceUrl(row.value, row.url)).toBe(row.run);
      expect(await traceSpanUrl(row.value, "span-1", row.url)).toBe(row.span);
      expect(
        await orqStudioUrl({
          targetKind: "agent",
          entityId: "entity",
          experimentUrl: row.url,
          workspaceId: "fallback",
        }),
      ).toBe(row.studio);
    });
  for (const [i, row] of goldens.keys.entries())
    test(`workspace UUID ${i}`, () =>
      expect(isStudioWorkspaceKey(row.value)).toBe(row.expected));
  for (const [i, row] of goldens.buttons.entries())
    test(`button ${i}`, () =>
      expect(
        traceLinkButton(row.url, '<Trace> & "test"', {
          onclick: row.options.onclick,
          extraAttributes: row.options.extra_attributes,
        }),
      ).toBe(row.expected));
  for (const [i, row] of goldens.origins.entries())
    test(`origin ${i}`, async () => {
      process.env.ORQ_BASE_URL = "https://env.example";
      await writeFile(
        process.env.EVALUATORQ_DASHBOARD_SETTINGS as string,
        JSON.stringify({
          orqAuthMethod: row.mode,
          orqProfile: "profile",
          orqProfileHost: row.host,
          orqOauthServer: row.host,
        }),
      );
      expect(await resolveBaseUrl()).toBe(row.expected);
    });
  for (const [i, row] of goldens.classify.entries())
    test(`host class ${i}`, () =>
      expect<string>(classifyHost(row.url)).toBe(row.expected));
  test("explicit workspace override rejects UUID and invalid entity types", async () => {
    process.env.ORQ_WORKSPACE = "0f4d7853-e58f-4c46-9a60-7992b27e920a";
    expect(studioWorkspaceKey("captured")).toBe("captured");
    expect(
      await orqStudioUrl({ targetKind: "unknown", entityId: "id" }),
    ).toBeNull();
    expect(
      await orqStudioUrl({ targetKind: "deployment", entityId: null }),
    ).toBeNull();
  });
});
describe("workspace resolution uses credential identity", () => {
  const response = [
    { data: [{ project_id: "p", name: "Project", workspace_id: "w" }] },
    { workspaces: [{ id: "w", key: "resolved" }] },
  ];
  test("saved OAuth selection precedes environment and needs no CLI", async () => {
    process.env.PATH = directory;
    process.env.ORQ_WORKSPACE = "env";
    await writeFile(
      process.env.EVALUATORQ_DASHBOARD_SETTINGS as string,
      JSON.stringify({ orqAuthMethod: "cli_oauth", orqWorkspace: "saved" }),
    );
    expect(await resolveSlug()).toBe("saved");
  });
  test("profile discovery is reused across renders and keyed by fingerprint", async () => {
    await fakeCli([...response, ...response]);
    const settings = process.env.EVALUATORQ_DASHBOARD_SETTINGS as string;
    await writeFile(
      settings,
      JSON.stringify({
        orqAuthMethod: "cli_profile",
        orqProfile: "chosen",
        orqCredentialFingerprint: "one",
      }),
    );
    expect(await cliSlugRenderScope(resolveSlug)).toBe("resolved");
    expect(await cliSlugRenderScope(resolveSlug)).toBe("resolved");
    expect((await calls()).length).toBe(2);
    await writeFile(
      settings,
      JSON.stringify({
        orqAuthMethod: "cli_profile",
        orqProfile: "chosen",
        orqCredentialFingerprint: "two",
      }),
    );
    expect(await resolveSlug()).toBe("resolved");
    expect((await calls()).length).toBe(4);
  });
  test("OAuth session discovery is reused only within each async render", async () => {
    await fakeCli([...response, ...response, ...response]);
    const first = await cliSlugRenderScope(() =>
      Promise.all([resolveSlug(), resolveSlug()]),
    );
    expect(first).toEqual(["resolved", "resolved"]);
    expect((await calls()).length).toBe(2);
    expect(await cliSlugRenderScope(resolveSlug)).toBe("resolved");
    expect((await calls()).length).toBe(4);
    expect(await resolveSlug()).toBe("resolved");
    expect((await calls()).length).toBe(6);
  });
  test("environment credential is selected explicitly and cached by identity", async () => {
    await fakeCli([...response, ...response]);
    process.env.ORQ_API_KEY = "fake-one";
    expect(await resolveSlug()).toBe("resolved");
    expect(await resolveSlug()).toBe("resolved");
    expect((await calls()).length).toBe(2);
    process.env.ORQ_API_KEY = "fake-two";
    expect(await resolveSlug()).toBe("resolved");
    expect((await calls()).length).toBe(4);
  });
});
