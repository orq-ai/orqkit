import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { RunManifest } from "../../../src/lib/contracts.js";
import type { OAuthScopes } from "../../../src/lib/dashboard/orq-scope.js";
import { csrfField } from "../../../src/lib/dashboard/security.js";
import {
  modelControl,
  oauthScopeField,
  oauthSessionField,
  profileField,
  renderFilterForm,
  reportBroken,
  reportInFlight,
  reportNotFound,
  reportViewWithFilters,
  settingsBody,
  settingsModelControl,
} from "../../../src/lib/dashboard/view.js";
import golden from "./fixtures/view-golden-2.json" with { type: "json" };

// Golden HTML rendered by the Python view.py from the same fixtures, with no
// model env vars and no settings file, and the CSRF field replaced by "CSRF".
const g = golden as Record<string, string>;
const ENV_KEYS = [
  "EVALUATORQ_DASHBOARD_SETTINGS",
  "EVALUATORQ_MODEL_OVERRIDES",
  "EVALUATORQ_FAST_MODEL",
  "EVALUATORQ_SMART_MODEL",
  "EVALUATORQ_CLASSIFIER_MODEL",
  "EVALUATORQ_EMBEDDING_MODEL",
  "EVALUATORQ_COMPILER_MODEL",
  "EVALUATORQ_APPLY_MODEL",
];
const saved = new Map<string, string | undefined>();
beforeAll(() => {
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.EVALUATORQ_DASHBOARD_SETTINGS = "/nonexistent/settings.json";
});
afterAll(() => {
  for (const [key, value] of saved) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

const groups = {
  openai: ["openai/gpt-5", "openai/o4"],
  anthropic: ["anthropic/claude-x"],
};
const sessions = [
  {
    server: "https://my.orq.ai/",
    host: "my.orq.ai",
    user: "amy",
    workspace: "ws",
    status: "valid",
  },
  {
    server: "https://b.orq",
    host: "b.orq",
    user: null,
    workspace: "",
    status: "unknown",
  },
  {
    server: "",
    host: "bad.orq",
    user: null,
    workspace: null,
    status: "unreadable",
  },
];
const scope: OAuthScopes = {
  workspaces: [
    { key: "w1", id: "id1" },
    { key: "w2", id: "id2" },
  ],
  projects: [
    { id: "p1", name: "Proj 1", workspaceId: "id1" },
    { id: "p2", name: "Proj 2", workspaceId: "id2" },
  ],
  error: null,
};
const profiles = [
  { name: "dev", server: "https://x", apiKey: "sk-1" },
  { name: "masked", server: null, apiKey: "sk-****" },
];
const settings = {
  smart_model: "openai/o4",
  orq_profile: "masked",
  orq_auth_method: "",
  ask_ai_mode: "review",
  orq_api_key_ciphertext: "x",
  orq_oauth_server: "https://a b/?q=1&r=~!",
  compression_inspector_enabled: "True",
  trace_input_chars: null,
  orq_workspace: "w1",
};
const t0 = new Date("2026-11-13T10:00:00Z");
const manifest = {
  status: "running",
  surface: "redteam",
  stage: null,
  error: "boom <x>",
  runName: "Run <1>",
  stages: [
    {
      name: "gen",
      target: "agent",
      status: "completed",
      startedAt: t0,
      endedAt: new Date(t0.getTime() + 12_340),
    },
    {
      name: "judge",
      target: null,
      status: "running",
      startedAt: t0,
      endedAt: null,
    },
  ],
} as unknown as RunManifest;

const simOpts = {
  goal_outcome: ["Achieved", "Not achieved", "Other"],
  terminated_by: ["judge", "max_turns"],
  persona: ["a", "b"],
  scenario: ["s"],
  max_turns: ["5"],
  max_total_tokens: ["1200"],
  metrics: ["hallucination_risk", "response_quality"],
};
const simSel = {
  goal_outcome: ["Achieved"],
  persona: ["a"],
  max_goal_score: ["0.75"],
  min_total_tokens: ["300"],
  min_hallucination_risk: ["0.2"],
  scenario: [],
};
const rtOpts = {
  result: ["Vulnerable", "Resistant", "Error", "Odd"],
  severity: ["Critical", "low", "x"],
  max_turns: ["1"],
  category: ["c1", "c2"],
  agent: ["a1", "a2"],
  technique: ["t"],
  delivery_method: [],
  vulnerability: ["v"],
};
const pwOpts = {
  winner: ["A", "B", "tie", "inconclusive", "extra"],
  judge: ["j1", "j2"],
};

describe("dashboard settings and filter views match view.py", () => {
  it("renders model controls", () => {
    expect(
      modelControl(
        "fast_model",
        "x",
        {},
        {
          label: "Fast",
          note: "n<",
          default: "d",
        },
      ),
    ).toBe(g.mc_plain);
    expect(modelControl("fast_model", "", {}, { label: "Fast" })).toBe(
      g.mc_req,
    );
    expect(
      modelControl("fast_model", "openai/o4", groups, {
        label: "Fast",
        default: "openai/gpt-5",
      }),
    ).toBe(g.mc_groups);
    expect(
      modelControl("fast_model", "mine/m", groups, {
        label: "Fast",
        note: "Set by X",
      }),
    ).toBe(g.mc_custom);
    expect(settingsModelControl("smart_model", "", groups)).toBe(g.smc);
  });

  it("renders the auth pickers", () => {
    expect(oauthSessionField("https://q", [])).toBe(g.oauth_none);
    expect(oauthSessionField("https://my.orq.ai", sessions)).toBe(g.oauth);
    expect(oauthSessionField("https://zzz", sessions)).toBe(g.oauth_missing);
    expect(oauthScopeField(scope, "w1", "p1")).toBe(g.scope);
    expect(oauthScopeField(scope, "nope", "p2")).toBe(g.scope_bad);
    expect(
      oauthScopeField({ ...scope, error: "Token <expired>" }, "w2", "pX"),
    ).toBe(g.scope_err);
    expect(
      oauthScopeField(
        { workspaces: [], projects: [], error: "down" },
        "w",
        "p",
      ),
    ).toBe(g.scope_err_only);
    expect(
      oauthScopeField({ workspaces: [], projects: [], error: null }, "w", "p"),
    ).toBe(g.scope_empty);
    expect(profileField("gone", profiles, "e")).toBe(g.profile);
    expect(profileField("masked", profiles)).toBe(g.profile_masked);
  });

  it("renders the settings page", () => {
    const strip = (html: string) => html.replace(csrfField(), "CSRF");
    expect(
      strip(
        settingsBody(
          [
            ["Roots", ["/a", "/b<"]],
            ["Port", "8000"],
          ],
          settings,
          {
            errors: {
              form: "bad",
              orq_profile: "p err",
              trace_input_chars: "too big",
              smart_model: "no",
            },
            preview: true,
            profiles,
          },
        ),
      ),
    ).toBe(g.settings);
    expect(strip(settingsBody([], {}, { saved: true }))).toBe(g.settings_plain);
  });

  it("renders report status pages", () => {
    expect(reportNotFound("a<b")).toBe(g.notfound);
    expect(reportInFlight(manifest)).toBe(g.inflight);
    expect(
      reportInFlight({
        ...manifest,
        stages: [],
        error: null,
        stage: "gen",
        surface: "custom",
      } as unknown as RunManifest),
    ).toBe(g.inflight_empty);
    expect(reportBroken("r", "f.json", "bad <json>")).toBe(g.broken);
  });

  it("renders the filter rails", () => {
    expect(
      renderFilterForm("r1", "sim", simOpts, simSel, { shown: 3, total: 9 }),
    ).toBe(g.filter_sim);
    expect(renderFilterForm("r1", "sim", {}, {})).toBe(g.filter_sim_min);
    expect(
      renderFilterForm(
        "r1",
        "redteam",
        rtOpts,
        {
          result: ["Resistant"],
          severity: ["low"],
          category: ["zzz"],
          min_turns: ["bad"],
        },
        { shown: 5, total: 5 },
      ),
    ).toBe(g.filter_rt);
    expect(
      renderFilterForm(
        "r1",
        "redteam",
        { ...rtOpts, max_turns: ["4"], agent: ["a1"] },
        { min_turns: ["2"] },
      ),
    ).toBe(g.filter_rt_turns);
    expect(
      renderFilterForm(
        "r1",
        "pairwise",
        pwOpts,
        { thrown_out: ["yes"], judge: ["j1"] },
        { shown: 1, total: 4 },
      ),
    ).toBe(g.filter_pw);
    expect(renderFilterForm("r1", "pairwise", pwOpts, { winner: ["B"] })).toBe(
      g.filter_pw_all,
    );
    expect(renderFilterForm("r1", "other", {}, {})).toBe(g.filter_other);
    expect(
      reportViewWithFilters("r<1", "sim", "<b>body</b>", "<form></form>"),
    ).toBe(g.fragment);
  });
});
