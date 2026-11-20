import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { OAuthSession } from "../../../src/lib/common/cli-oauth.js";
import type { OrqProfile } from "../../../src/lib/common/orq-client.js";
import { createDashboardHandler } from "../../../src/lib/dashboard/app.js";
import { DashboardAuth } from "../../../src/lib/dashboard/auth.js";
import { CSRF_FIELD, csrfToken } from "../../../src/lib/dashboard/security.js";
import type { SettingsRouteDeps } from "../../../src/lib/dashboard/settings-routes.js";
import { loadDashboardSettings } from "../../../src/lib/trace-finder/settings.js";

type Json = { errors: Record<string, string>; sidebar: string };
const MODELS = {
  fast_model: "fast/custom",
  smart_model: "smart/custom",
  classifier_model: "classifier/custom",
  embedding_model: "embed/custom",
};
const CHOICES = { openai: ["openai/gpt-5.6-luna"], anthropic: ["anthropic/x"] };
const ENV = [
  "EVALUATORQ_DASHBOARD_SETTINGS",
  "EVALUATORQ_USER_SETTINGS",
  "EVALUATORQ_FAST_MODEL",
  "EVALUATORQ_SMART_MODEL",
  "EVALUATORQ_CLASSIFIER_MODEL",
  "EVALUATORQ_EMBEDDING_MODEL",
  "EVALUATORQ_COMPILER_MODEL",
  "EVALUATORQ_APPLY_MODEL",
  "EVALUATORQ_FINDER_WINDOW_DAYS",
  "EVALUATORQ_FINDER_LIMIT",
  "EVALUATORQ_FINDER_PARALLELISM",
  "ORQ_API_KEY",
  "ORQ_WORKSPACE",
];
const saved: Record<string, string | undefined> = {};
let dir = "";
let settingsFile = "";

beforeEach(async () => {
  for (const name of ENV) saved[name] = process.env[name];
  for (const name of ENV) delete process.env[name];
  dir = resolve(await mkdtemp(join(process.env.TMPDIR ?? ".", "settings-")));
  settingsFile = join(dir, "dashboard-settings.json");
  process.env.EVALUATORQ_DASHBOARD_SETTINGS = settingsFile;
  process.env.EVALUATORQ_USER_SETTINGS = join(dir, "user-settings.json");
  process.env.ORQ_WORKSPACE = "ws";
});
afterEach(() => {
  for (const name of ENV)
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
});

const profile = (name: string, apiKey = "key"): OrqProfile => ({
  name,
  apiKey,
  server: null,
  active: false,
});
const session = (server: string): OAuthSession =>
  ({
    server,
    host: server,
    user: null,
    workspace: null,
    status: "valid",
    active: true,
  }) as OAuthSession;

function app(deps: SettingsRouteDeps = {}) {
  return createDashboardHandler({
    roots: [dir],
    settings: {
      listProfiles: async () => [],
      listOauthSessions: () => [],
      ...deps,
    },
  });
}

function post(
  handler: ReturnType<typeof app>,
  values: Record<string, string>,
  options: { csrf?: boolean; headers?: Record<string, string> } = {},
) {
  const body = new URLSearchParams(
    options.csrf === false ? values : { [CSRF_FIELD]: csrfToken(), ...values },
  );
  return handler(
    new Request("http://local/settings", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...options.headers,
      },
    }),
  );
}
const get = (handler: ReturnType<typeof app>, path: string) =>
  handler(new Request(`http://local${path}`));

describe("settings routes", () => {
  it("saves and redirects", async () => {
    const response = await post(app(), {
      ...MODELS,
      window_days: "14",
      trace_input_chars: "230000",
      ask_ai_mode: "review",
      filter_selection: "llm",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/settings?saved=1");
    const stored = await loadDashboardSettings(settingsFile);
    expect(stored.fastModel).toBe("fast/custom");
    expect(stored.traceInputChars).toBe(230000);
    expect(stored.askAiMode).toBe("review");
    expect(stored.filterSelection).toBe("llm");
    expect(stored.windowDays).toBe(
      (await loadDashboardSettings(join(dir, "none.json"))).windowDays,
    );
  });

  it("keeps future fields while saving known edits", async () => {
    const future = {
      future_flag: true,
      future_settings: { nested: ["keep", 3] },
    };
    await writeFile(
      settingsFile,
      JSON.stringify({ schema_version: 2, window_days: 8, ...future }),
    );
    const response = await post(app(), {
      fast_model: "fast/edited",
      classifier_model: "classifier/custom",
    });
    expect(response.status).toBe(303);
    const raw = JSON.parse(await readFile(settingsFile, "utf8"));
    expect(raw.future_flag).toBe(true);
    expect(raw.future_settings).toEqual(future.future_settings);
    expect((await loadDashboardSettings(settingsFile)).fastModel).toBe(
      "fast/edited",
    );
  });

  it("requires the CSRF token and a same-origin request", async () => {
    const handler = app();
    expect((await post(handler, MODELS, { csrf: false })).status).toBe(403);
    expect(
      (await post(handler, { ...MODELS, [CSRF_FIELD]: "wrong" })).status,
    ).toBe(403);
    expect(
      (
        await post(handler, MODELS, {
          headers: { "sec-fetch-site": "cross-site" },
        })
      ).status,
    ).toBe(403);
    const autosave = await post(handler, MODELS, {
      csrf: false,
      headers: { "x-autosave": "1" },
    });
    expect(autosave.status).toBe(403);
    expect(((await autosave.json()) as Json).errors.form).toBeTruthy();
    expect(existsSync(settingsFile)).toBe(false);
  });

  it("rejects an invalid filter selection", async () => {
    const response = await post(app(), {
      ...MODELS,
      filter_selection: "merged",
    });
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("filter_selection");
  });

  it("rejects a changed-field marker for the hidden schema version", async () => {
    const original = JSON.stringify({
      schema_version: 1,
      fast_model: "saved/fast",
    });
    await writeFile(settingsFile, original);
    const response = await post(app(), {
      fast_model: "fast/new",
      settings_changed_fields: "schema_version",
    });
    expect(response.status).toBe(422);
    expect(await readFile(settingsFile, "utf8")).toBe(original);
  });

  it("fails visibly without overwriting a malformed file", async () => {
    await writeFile(settingsFile, "{malformed saved settings");
    const response = await post(app(), {
      fast_model: "fast/new",
      settings_changed_fields: "fast_model",
    });
    expect(response.status).toBe(422);
    expect(await response.text()).toContain(
      "saved file is unreadable or invalid",
    );
    expect(await readFile(settingsFile, "utf8")).toBe(
      "{malformed saved settings",
    );
  });

  it("rejects an unknown profile", async () => {
    const response = await post(
      app({ listProfiles: async () => [profile("work")] }),
      { ...MODELS, orq_profile: "ghost" },
    );
    expect(response.status).toBe(422);
    expect(await response.text()).toContain(
      "The orq CLI does not know this profile",
    );
    expect(existsSync(settingsFile)).toBe(false);
  });

  it("refuses a profile whose key the CLI masks", async () => {
    const response = await post(
      app({ listProfiles: async () => [profile("work", "****abcd")] }),
      { ...MODELS, orq_auth_method: "cli_profile", orq_profile: "work" },
    );
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("masks this profile key");
  });

  it("saves a profile and records its host and fingerprint", async () => {
    const response = await post(
      app({ listProfiles: async () => [profile("work")] }),
      { ...MODELS, orq_auth_method: "cli_profile", orq_profile: "work" },
    );
    expect(response.status).toBe(303);
    const stored = await loadDashboardSettings(settingsFile);
    expect(stored.orqAuthMethod).toBe("cli_profile");
    expect(stored.orqProfile).toBe("work");
    expect(stored.orqProfileHost).toBe("https://my.orq.ai");
    expect(stored.orqCredentialFingerprint).toBeTruthy();
  });

  it("asks for a key when stored-key auth has none", async () => {
    const response = await post(app(), {
      ...MODELS,
      orq_auth_method: "stored_api_key",
    });
    expect(response.status).toBe(422);
    expect(await response.text()).toContain(
      "Enter an API key to use this method.",
    );
  });

  it("returns field errors as JSON when autosaving", async () => {
    const response = await post(
      app(),
      { ...MODELS, filter_selection: "merged" },
      { headers: { "x-autosave": "1" } },
    );
    expect(response.status).toBe(422);
    expect(Object.keys(((await response.json()) as Json).errors)).toContain(
      "filter_selection",
    );
  });

  it("returns the sidebar after an autosave", async () => {
    const response = await post(
      app(),
      { fast_model: "fast/auto", settings_changed_fields: "fast_model" },
      { headers: { "x-autosave": "1" } },
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as Json).sidebar).toContain("<");
  });

  it("shows saved values and the saved confirmation", async () => {
    await post(app(), MODELS);
    const page = await (await get(app(), "/settings?saved=1")).text();
    expect(page).toContain('value="smart/custom"');
    expect(page).toContain("<title>");
  });

  it("does not query the CLI for an unlisted OAuth server", async () => {
    const response = await get(
      app({
        discoverOauthScopes: () => {
          throw new Error("unlisted server reached the CLI");
        },
      }),
      "/settings/oauth-scope?orq_oauth_server=http://169.254.169.254",
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Sign in to this Orq server");
  });

  it("lists OAuth scopes for a signed-in server", async () => {
    const response = await get(
      app({
        listOauthSessions: () => [session("https://my.orq.ai")],
        discoverOauthScopes: async () => ({
          workspaces: [],
          projects: [],
          error: null,
        }),
      }),
      "/settings/oauth-scope?orq_oauth_server=https://my.orq.ai/",
    );
    expect(await response.text()).toContain("No workspaces available");
  });

  it("falls back to a server box without OAuth sessions", async () => {
    const text = await (
      await get(app(), "/settings/oauth-sessions?value=https://x.test")
    ).text();
    expect(text).toContain(
      'name="orq_oauth_server" type="url" value="https://x.test"',
    );
  });

  it("offers workspace models grouped by provider", async () => {
    process.env.ORQ_API_KEY = "test-key";
    const handler = app({ loadModels: async () => CHOICES });
    const text = await (
      await get(
        handler,
        "/settings/models?field=fast_model&fast_model=openai/gpt-5.6-luna",
      )
    ).text();
    expect(text).toContain(
      '<input type="hidden" name="fast_model" value="openai/gpt-5.6-luna">',
    );
    expect(text).toContain('<div class="hd">openai</div>');
    expect(text).toContain('id="models-warning" hx-swap-oob="innerHTML"></p>');
  });

  it("returns nothing for an unknown model field", async () => {
    expect(await (await get(app(), "/settings/models?field=nope")).text()).toBe(
      "",
    );
  });

  it("explains rejected credentials rather than an outage", async () => {
    const handler = app({
      resolveDashboardAuth: async () =>
        new DashboardAuth("environment", "k", "https://my.orq.ai"),
      loadModels: async () => {
        throw Object.assign(new Error("rejected"), { status: 401 });
      },
    });
    const text = await (
      await get(
        handler,
        "/settings/models?field=fast_model&orq_auth_method=environment",
      )
    ).text();
    expect(text).toContain(
      "Orq credentials need attention, so the model list cannot load.",
    );
    expect(text).not.toContain("temporarily unavailable");
  });

  it("reports an outage when the catalogue fails for another reason", async () => {
    const handler = app({
      resolveDashboardAuth: async () =>
        new DashboardAuth("environment", "k", "https://my.orq.ai"),
      loadModels: async () => {
        throw new Error("boom");
      },
    });
    const text = await (
      await get(handler, "/settings/models?field=fast_model")
    ).text();
    expect(text).toContain("temporarily unavailable");
  });

  it("keeps the empty catalogue note distinct", async () => {
    const handler = app({
      resolveDashboardAuth: async () =>
        new DashboardAuth("environment", "k", "https://my.orq.ai"),
      loadModels: async () => ({}),
    });
    const text = await (
      await get(handler, "/settings/models?field=fast_model")
    ).text();
    expect(text).toContain(
      "Orq returned no models for this field. Type a model id.",
    );
    expect(text).not.toContain("temporarily unavailable");
  });

  it("asks for credentials when none resolve", async () => {
    const handler = app({
      resolveDashboardAuth: async () => {
        throw new Error("no key");
      },
    });
    const text = await (
      await get(handler, "/settings/models?field=fast_model")
    ).text();
    expect(text).toContain("Set ORQ_API_KEY in the environment.");
  });
});
