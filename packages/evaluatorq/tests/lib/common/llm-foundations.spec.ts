import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod/v4";

import {
  ENV_VARS,
  envBool,
  envFloat,
  envInt,
  envRaw,
  envText,
  maskSecret,
  report,
} from "../../../src/lib/common/env-config.js";
import { getField } from "../../../src/lib/common/fields.js";
import {
  clientRoutesThroughOrq,
  MissingLLMCredentialsError,
  orqBaseUrl,
  resolveLlmClient,
  resolveResultsBaseUrl,
} from "../../../src/lib/common/llm-client.js";
import {
  addCliModels,
  exportCliModels,
  loadModelSettings,
  OVERRIDES_ENV,
  parseOverrides,
  roleModel,
  roleSource,
  setCliModels,
  taskOverride,
} from "../../../src/lib/common/model-roles.js";
import {
  firstResponsesRefusal,
  parseResponsesResponse,
  responsesStopReason,
  responsesTextConfig,
  scrubWireSchema,
} from "../../../src/lib/common/responses.js";
import {
  extractTemplatePaths,
  isValidTemplatePath,
  renderTemplate,
  resolveTemplatePath,
} from "../../../src/lib/common/template-engine.js";
import {
  buildStaticThreadId,
  buildThreadId,
  conversationThread,
  currentThreadId,
  evaluatorqPipeline,
  evaluatorqRunId,
  pipelineMetadata,
  pipelineMetadataParam,
  threadBodyParam,
  warnOnce,
} from "../../../src/lib/common/thread-context.js";

const MANAGED = [
  "ORQ_API_KEY",
  "ORQ_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "EVALUATORQ_FAST_MODEL",
  "EVALUATORQ_SMART_MODEL",
  "EVALUATORQ_COMPILER_MODEL",
  "EVALUATORQ_DASHBOARD_SETTINGS",
  "EVALUATORQ_LLM_TIMEOUT_S",
  "EVALUATORQ_LLM_MAX_TOKENS",
  "EVALUATORQ_FINDER_LIMIT",
  "ORQ_DISABLE_TRACING",
  OVERRIDES_ENV,
];

let saved: Record<string, string | undefined> = {};
let warn: ReturnType<typeof spyOn>;
let stderr: ReturnType<typeof spyOn>;

beforeEach(() => {
  saved = Object.fromEntries(MANAGED.map((k) => [k, process.env[k]]));
  for (const key of MANAGED) {
    delete process.env[key];
  }
  warn = spyOn(console, "warn").mockImplementation(() => {});
  stderr = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  setCliModels();
  warn.mockRestore();
  stderr.mockRestore();
});

describe("getField", () => {
  test("keeps stored nulls and falls back when absent", () => {
    expect(getField({ a: null }, "a", 1)).toBeNull();
    expect(getField({}, "a", 1)).toBe(1);
    expect(getField(null, "a", 1)).toBe(1);
  });
});

describe("env config", () => {
  test("refuses undeclared names and wrong kinds", () => {
    expect(() => envRaw("NOPE")).toThrow("not declared");
    expect(() => envInt("ORQ_API_KEY")).toThrow("declared as 'raw'");
  });

  test("raw is untouched and text strips", () => {
    process.env.ORQ_BASE_URL = " x ";
    expect(envRaw("ORQ_BASE_URL")).toBe(" x ");
    expect(envText("ORQ_BASE_URL")).toBe("x");
    process.env.ORQ_BASE_URL = "  ";
    expect(envText("ORQ_BASE_URL")).toBeUndefined();
  });

  test.each([
    ["250", 250, 0],
    [" 1_000 ", 1000, 0],
    ["", 500, 1],
    ["1.5", 500, 1],
    ["0x10", 500, 1],
    ["0", 500, 1],
    ["5001", 500, 1],
  ])("int %p reads %p", (raw, want, warnings) => {
    process.env.EVALUATORQ_FINDER_LIMIT = raw;
    expect(envInt("EVALUATORQ_FINDER_LIMIT")).toBe(want);
    expect(warn).toHaveBeenCalledTimes(warnings);
  });

  test.each([
    ["1.5", 1.5],
    [".5e1", 5],
    ["inf", 60],
    ["nan", 60],
    ["abc", 60],
    ["0.5", 60],
  ])("float %p reads %p", (raw, want) => {
    process.env.EVALUATORQ_LLM_TIMEOUT_S = raw;
    expect(envFloat("EVALUATORQ_LLM_TIMEOUT_S")).toBe(want);
  });

  test.each([
    ["YES", true, 0],
    ["off", false, 0],
    ["", false, 0],
    ["maybe", false, 1],
  ])("bool %p reads %p", (raw, want, warnings) => {
    process.env.ORQ_DISABLE_TRACING = raw;
    expect(envBool("ORQ_DISABLE_TRACING")).toBe(want);
    expect(warn).toHaveBeenCalledTimes(warnings);
  });

  test("maskSecret never reveals short keys", () => {
    expect(maskSecret("abc")).toBe("***");
    expect(maskSecret("abcdefgh")).toBe("****efgh");
    expect(maskSecret("x".repeat(40))).toHaveLength(20);
  });

  test("report masks secrets and marks rejected values", () => {
    process.env.ORQ_API_KEY = "secret-key-1234";
    process.env.EVALUATORQ_LLM_MAX_TOKENS = "abc";
    const rows = new Map(report().map((r) => [r.name, r]));
    expect(rows.size).toBe(ENV_VARS.size);
    expect(rows.get("ORQ_API_KEY")?.value).toBe("***********1234");
    expect(rows.get("EVALUATORQ_LLM_MAX_TOKENS")?.status).toBe("rejected");
    expect(rows.get("ORQ_BASE_URL")?.status).toBe("unset");
  });
});

describe("thread context", () => {
  test("concurrent conversations stay isolated", async () => {
    const seen = await Promise.all(
      ["a", "b", "c"].map((id) =>
        conversationThread(id, async () => {
          await new Promise((r) => setTimeout(r, 1));
          return currentThreadId();
        }),
      ),
    );
    expect(seen).toEqual(["a", "b", "c"]);
    expect(currentThreadId()).toBeNull();
  });

  test("generates an id when none is given", () => {
    conversationThread(null, (id) => {
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(threadBodyParam()).toEqual({ thread: { id } });
    });
    expect(threadBodyParam()).toEqual({});
  });

  test("pipeline and run id compose and restore", () => {
    evaluatorqPipeline("red_teaming", () =>
      evaluatorqRunId("r1", () => {
        expect(pipelineMetadata()).toEqual({
          evaluatorq_pipeline: "red_teaming",
          evaluatorq_run_id: "r1",
        });
      }),
    );
    expect(pipelineMetadataParam()).toEqual({});
  });

  test("thread ids", () => {
    expect(buildThreadId(null, 1)).toBeNull();
    expect(buildThreadId("r", "agent", 2)).toBe("r:agent:2");
    expect(buildStaticThreadId(null, "t", 3)).toBe("static-t:t:3");
    expect(buildStaticThreadId("r", "t", 3)).toBe("r:t:3");
  });

  test("warnOnce warns once per conversation and always outside one", () => {
    conversationThread("x", () => {
      warnOnce(["k"], "m");
      warnOnce(["k"], "m");
      warnOnce(["k", "j"], "m");
    });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(stderr).toHaveBeenCalledTimes(1);
    warnOnce(["k"], "m");
    warnOnce(["k"], "m");
    expect(warn).toHaveBeenCalledTimes(4);
  });
});

describe("template engine", () => {
  const data = {
    name: "Ada",
    nested: { list: [{ v: 1 }, { v: 2 }] },
    "a.b": "flat",
    a: { b: "deep" },
    input: { text: "hi" },
    yes: true,
    nil: null,
    "0": "zero",
    obj: { x: "é" },
  };

  test.each([
    ["{{name}}", "Ada"],
    ["{{ name }}", "Ada"],
    ["{{na me}}", "{{na me}}"],
    ["{{nested.list[0].v}}", "1"],
    ["{{nested.list[-1].v}}", "2"],
    ["{{nested.list[5].v}}", "{{nested.list[5].v}}"],
    ["{{a.b}}", "flat"],
    ["{{input.text}}", "hi"],
    ["{{input}}", "{{input}}"],
    ["{{missing}}", "{{missing}}"],
    ["{{yes}} {{nil}}", "True None"],
    ["{{constructor.name}}", "{{constructor.name}}"],
    ["{{a;b}}", "{{a;b}}"],
    ["{{obj}}", '{\n  "x": "\\u00e9"\n}'],
  ])("%s", (template, want) => {
    expect(renderTemplate(template, data)).toBe(want);
  });

  test("a resolved value is never re-expanded", () => {
    expect(renderTemplate("{{a}}", { a: "{{b}}", b: "x" })).toBe("{{b}}");
  });

  test("a placeholder cannot span a newline", () => {
    expect(renderTemplate("{{a\n}}", { a: "x" })).toBe("{{a\n}}");
  });

  test("extractTemplatePaths is unique, ordered and skips rejected ones", () => {
    expect(
      extractTemplatePaths("{{b}} {{a.c}} {{b}} {{input}} {{x y}} {{a(1)}}"),
    ).toEqual(["b", "a.c"]);
  });

  test("resolveTemplatePath order and stored null", () => {
    const both = { "a.b": "flat", a: { b: "deep" }, n: null };
    expect(resolveTemplatePath(both, "a.b").value).toBe("flat");
    expect(resolveTemplatePath(both, "a.b", { preferNested: true }).value).toBe(
      "deep",
    );
    expect(resolveTemplatePath(both, "n")).toEqual({
      found: true,
      value: null,
    });
    expect(resolveTemplatePath(both, "z").found).toBe(false);
  });

  test("path whitelist", () => {
    expect(isValidTemplatePath("a.b[0].c")).toBe(true);
    expect(isValidTemplatePath("a.0")).toBe(true);
    expect(isValidTemplatePath("0a")).toBe(false);
    expect(isValidTemplatePath("a()")).toBe(false);
  });
});

describe("responses helpers", () => {
  const schema = z.object({
    score: z.number().describe("the score"),
    note: z.string().default("x"),
  });

  test("text config is strict and strips defaults", () => {
    const { format } = responsesTextConfig("Verdict", schema.describe("why"), {
      scrub: true,
    });
    expect(format).toMatchObject({
      type: "json_schema",
      strict: true,
      name: "Verdict",
    });
    const wire = format.schema as {
      description?: string;
      properties?: Record<string, object>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(wire.description).toBeUndefined();
    expect(wire.properties?.note).not.toHaveProperty("default");
    expect(wire.properties?.score).toHaveProperty("description");
    expect(wire.required).toEqual(["score", "note"]);
    expect(wire.additionalProperties).toBe(false);
  });

  test("scrub tolerates a schema without properties", () => {
    expect(scrubWireSchema({ description: "x", type: "string" })).toEqual({
      type: "string",
    });
  });

  test("refusal", () => {
    const response = {
      output: [{ content: [{ type: "refusal", refusal: "no" }] }],
    };
    expect(firstResponsesRefusal(response)).toBe("no");
    expect(firstResponsesRefusal({ output: [] })).toBeNull();
  });

  test.each([
    [{ incomplete_details: { reason: "max_output_tokens" } }, "length"],
    [{ stop_reason: "max_output_tokens" }, "length"],
    [
      {
        stop_reason: "stop",
        incomplete_details: { reason: "max_output_tokens" },
      },
      "length",
    ],
    [{ stop_reason: "stop" }, "stop"],
    [{ incomplete_details: { reason: "content_filter" } }, "content_filter"],
    [{}, null],
  ])("stop reason %#", (response, want) => {
    expect(responsesStopReason(response)).toBe(want);
  });

  test("parses output_text or the output parts", () => {
    const direct = { output_text: '{"score":1,"note":"a"}' };
    const parts = {
      output: [
        {
          content: [{ type: "output_text", text: '{"score":2,"note":"b"}' }],
        },
      ],
    };
    expect(parseResponsesResponse(direct, schema).outputParsed?.score).toBe(1);
    expect(parseResponsesResponse(parts, schema).outputParsed?.score).toBe(2);
    expect(parseResponsesResponse({}, schema).outputParsed).toBeNull();
    expect(() =>
      parseResponsesResponse({ output_text: '{"score":"x"}' }, schema),
    ).toThrow();
  });
});

describe("llm client", () => {
  test("an injected client is used as is and not owned", async () => {
    const client = { baseURL: "https://h/v3/router/" } as never;
    expect(await resolveLlmClient(client)).toEqual({
      client,
      owned: false,
      routesThroughOrq: true,
    });
  });

  test("ORQ_API_KEY wins and goes through the router", async () => {
    process.env.ORQ_API_KEY = "o";
    process.env.OPENAI_API_KEY = "x";
    process.env.ORQ_BASE_URL = "https://staging.orq.ai/";
    const resolved = await resolveLlmClient(null, { maxRetries: 0 });
    expect(resolved.routesThroughOrq).toBe(true);
    expect(resolved.owned).toBe(true);
    expect(resolved.client.baseURL).toBe("https://staging.orq.ai/v3/router");
    expect(resolved.client.apiKey).toBe("o");
    expect(resolved.client.maxRetries).toBe(0);
  });

  test("an explicit key and host beat the environment", async () => {
    process.env.ORQ_API_KEY = "o";
    const { client } = await resolveLlmClient(null, {
      extraApiKey: "e",
      orqHost: "https://h",
    });
    expect(client.apiKey).toBe("e");
    expect(client.baseURL).toBe("https://h/v3/router");
  });

  test("OPENAI fallback honours the base url only when asked", async () => {
    process.env.OPENAI_API_KEY = "x";
    process.env.OPENAI_BASE_URL = "https://vllm/v1";
    const honored = await resolveLlmClient();
    expect(honored.client.baseURL).toBe("https://vllm/v1");
    expect(honored.routesThroughOrq).toBe(false);
    const forced = await resolveLlmClient(null, { honorOpenaiBaseUrl: false });
    expect(forced.client.baseURL).toBe("https://api.openai.com/v1");
  });

  test("missing credentials", async () => {
    await expect(resolveLlmClient()).rejects.toThrow(
      MissingLLMCredentialsError,
    );
    process.env.OPENAI_API_KEY = "x";
    await expect(resolveLlmClient(null, { requireOrq: true })).rejects.toThrow(
      "ORQ routing is required",
    );
  });

  test("results host follows an Orq routed client only", () => {
    process.env.ORQ_BASE_URL = "https://env.orq.ai/";
    expect(orqBaseUrl()).toBe("https://env.orq.ai");
    expect(resolveResultsBaseUrl({ baseURL: "https://stage/v3/router/" })).toBe(
      "https://stage",
    );
    expect(
      resolveResultsBaseUrl({ baseURL: "https://api.openai.com/v1" }),
    ).toBe("https://env.orq.ai");
    expect(clientRoutesThroughOrq(null)).toBe(false);
  });
});

describe("model roles", () => {
  let dir: string;
  const writeSettings = (data: unknown) => {
    const path = join(dir, "settings.json");
    writeFileSync(path, JSON.stringify(data));
    process.env.EVALUATORQ_DASHBOARD_SETTINGS = path;
    return path;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "roles-"));
    process.env.EVALUATORQ_DASHBOARD_SETTINGS = join(dir, "absent.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("falls back to the built-in", () => {
    expect(roleModel("fast")).toBe("openai/gpt-6-luna");
    expect(roleSource("fast")).toBe("default");
  });

  test("precedence walks flag, legacy env, task setting, env, role setting", () => {
    writeSettings({
      schema_version: 1,
      fast_model: "saved-fast",
      model_overrides: { "finder.compiler": "saved-task" },
    });
    expect(roleModel("fast", { task: "sim.user" })).toBe("saved-fast");
    process.env.EVALUATORQ_FAST_MODEL = "env-fast";
    expect(roleModel("fast", { task: "sim.user" })).toBe("env-fast");
    expect(roleSource("fast", "sim.user")).toBe("env");
    expect(roleModel("fast", { task: "finder.compiler" })).toBe("saved-task");
    process.env.EVALUATORQ_COMPILER_MODEL = "legacy";
    expect(roleModel("fast", { task: "finder.compiler" })).toBe("legacy");
    addCliModels({ fast: " flag " });
    expect(roleModel("fast", { task: "finder.compiler" })).toBe("flag");
    addCliModels(null, { "finder.compiler": "pin" });
    expect(taskOverride("finder.compiler")).toEqual({
      model: "pin",
      label: "--model-override",
    });
    expect(taskOverride("sim.user")).toBeNull();
  });

  test("a task from another role is refused", () => {
    expect(() => roleModel("smart", { task: "sim.user" })).toThrow(
      "belongs to role 'fast'",
    );
  });

  test("parseOverrides", () => {
    expect(parseOverrides(["sim.user = m"])).toEqual({ "sim.user": "m" });
    expect(() => parseOverrides(["sim.user"])).toThrow("expected task=model");
    expect(() => parseOverrides(["nope=m"])).toThrow("unknown task");
  });

  test("flags reach a child through the environment", () => {
    setCliModels({ smart: "s" }, { "sim.user": "u" });
    exportCliModels();
    setCliModels();
    expect(roleModel("smart")).toBe("s");
    expect(roleModel("fast", { task: "sim.user" })).toBe("u");
    delete process.env[OVERRIDES_ENV];
    exportCliModels();
    expect(process.env[OVERRIDES_ENV]).toBeUndefined();
  });

  test("a malformed inherited value is ignored with a warning", () => {
    process.env[OVERRIDES_ENV] = "not json";
    expect(roleModel("fast")).toBe("openai/gpt-6-luna");
    expect(warn).toHaveBeenCalled();
  });

  test("legacy settings migrate and old defaults are not frozen", () => {
    const path = writeSettings({
      compiler_model: "my-compiler",
      apply_model: "openai/gpt-5.6-luna",
      classifier_model: "typesafe/jev-latest",
      smart_model: "  ",
    });
    expect(loadModelSettings(path)).toEqual({
      roles: {},
      modelOverrides: { "finder.compiler": "my-compiler" },
    });
  });

  test("bad settings fall back without throwing", () => {
    expect(loadModelSettings(writeSettings([1]))).toEqual({
      roles: {},
      modelOverrides: {},
    });
    expect(loadModelSettings(writeSettings({ schema_version: true }))).toEqual({
      roles: {},
      modelOverrides: {},
    });
    expect(
      loadModelSettings(
        writeSettings({
          schema_version: 1,
          fast_model: 5,
          smart_model: "s",
          model_overrides: { nope: "m", "sim.user": " " },
        }),
      ),
    ).toEqual({ roles: { smart: "s" }, modelOverrides: {} });
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{");
    expect(loadModelSettings(broken).roles).toEqual({});
  });
});
