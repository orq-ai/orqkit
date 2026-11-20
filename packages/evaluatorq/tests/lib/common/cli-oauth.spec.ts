// Ported from res-697 tests/common/test_cli_oauth.py.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  buildCliOauthClients,
  cliProcess,
  OrqCLIError,
  oauthSubject,
  type ProcessResult,
  type RunOptions,
} from "../../../src/lib/common/cli-oauth.js";

type Call = { args: string[]; options: RunOptions };
const original = { ...cliProcess };
const savedEnv = { ...process.env };
let calls: Call[];

function fakeAsync(
  out: string | ((args: string[]) => string),
  rc = 0,
  stderr = "",
) {
  cliProcess.runAsync = async (args, options) => {
    calls.push({ args, options });
    return {
      returncode: rc,
      stdout: typeof out === "string" ? out : out(args),
      stderr,
    };
  };
}

function fakeSync(result: Partial<ProcessResult>) {
  cliProcess.runSync = (args, options) => {
    calls.push({ args, options });
    return { returncode: 0, stdout: "", stderr: "", ...result };
  };
}

beforeEach(() => {
  calls = [];
  cliProcess.which = () => "/usr/local/bin/orq";
});
afterEach(() => {
  Object.assign(cliProcess, original);
  for (const key of Object.keys(process.env))
    if (!Object.hasOwn(savedEnv, key)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

const body = (i = 0) => JSON.parse(calls[i]?.options.input ?? "null");

async function catchError(p: Promise<unknown> | (() => unknown)) {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    return e as OrqCLIError;
  }
  throw new Error("expected an error");
}

describe("CLI OAuth model client", () => {
  it("parse forwards the response format and sets parsed", async () => {
    fakeAsync(
      '{"choices":[{"message":{"content":"{\\"answer\\":\\"ready\\"}"}}]}',
    );
    const [, llm] = buildCliOauthClients("https://my.orq.ai");
    const format = {
      type: "json_schema",
      json_schema: {
        name: "Answer",
        schema: { type: "object", additionalProperties: false },
        strict: true,
      },
    };
    const result = (await llm.chat.completions.parse({
      model: "openai/gpt-6-luna",
      messages: [],
      response_format: format,
      responseParser: (c: string) => JSON.parse(c),
    })) as { choices: { message: { parsed: unknown } }[] };
    expect(body().response_format.json_schema.schema.additionalProperties).toBe(
      false,
    );
    expect(body()).not.toHaveProperty("responseParser");
    expect(result.choices[0]?.message.parsed).toEqual({ answer: "ready" });
  });

  it("decisions post uses the OAuth request endpoint and drops headers", async () => {
    fakeAsync('{"body":{"answers":{}},"ok":true,"status":200}');
    process.env.ORQ_API_KEY = "must-not-be-forwarded";
    const [, llm] = buildCliOauthClients("https://my.orq.ai");
    const result = await llm.post("/decisions", {
      body: { model: "typesafe/jev-latest", state: {}, questions: {} },
    });
    expect(result).toEqual({ answers: {} });
    expect(calls[0]?.args.slice(-5)).toEqual([
      "request",
      "POST",
      "/v3/router/decisions",
      "--force",
      "--stdin",
    ]);
    expect(body().model).toBe("typesafe/jev-latest");
    expect(calls[0]?.options.env).not.toHaveProperty("ORQ_API_KEY");
  });

  it("model catalogue unwraps the response without ambient keys", async () => {
    fakeAsync('{"body":[{"model_id":"gpt-6-luna"}],"ok":true,"status":200}');
    process.env.ORQ_API_KEY = "ambient-key-must-not-be-used";
    const [, llm] = buildCliOauthClients("https://my.orq.ai");
    expect(await llm.getModelCatalogue()).toEqual([{ model_id: "gpt-6-luna" }]);
    expect(calls[0]?.args.slice(-4)).toEqual([
      "request",
      "GET",
      "/v2/models",
      "--force",
    ]);
    expect(calls[0]?.options.env).not.toHaveProperty("ORQ_API_KEY");
  });

  it("model catalogue keeps the auth status", async () => {
    fakeAsync('{"body":{"error":"unauthorized"},"ok":false,"status":401}');
    const [, llm] = buildCliOauthClients();
    const error = await catchError(llm.getModelCatalogue());
    expect(error.statusCode).toBe(401);
    expect(error.failureKind).toBe("authentication");
  });

  for (const stderr of [
    "Error: missing API key; configure a profile with auth setup or set ORQ_API_KEY",
    "Error: authentication required",
    "Error: OAuth refresh token expired or was revoked; run 'orq auth login'",
  ])
    it(`classifies missing or expired auth: ${stderr.slice(7, 30)}`, async () => {
      fakeAsync("", 1, stderr);
      const [, llm] = buildCliOauthClients();
      expect((await catchError(llm.getModelCatalogue())).failureKind).toBe(
        "authentication",
      );
    });

  it("keeps an unreadable failure as unavailable", async () => {
    fakeAsync("", 1, "connection refused");
    const [, llm] = buildCliOauthClients();
    expect((await catchError(llm.getModelCatalogue())).failureKind).toBe(
      "unavailable",
    );
  });

  it("redacts credential-shaped text in errors", async () => {
    fakeAsync("", 1, "request failed Bearer super-secret-token");
    const [, llm] = buildCliOauthClients();
    const error = await catchError(
      llm.embeddings.create({
        model: "openai/text-embedding-3-small",
        input: "hello",
      }),
    );
    expect(error.message).toContain("Bearer [redacted]");
    expect(error.message).not.toContain("super-secret-token");
  });

  it("raises a setup error when the CLI is missing", async () => {
    cliProcess.which = () => null;
    const error = await catchError(() => buildCliOauthClients());
    expect(error.failureKind).toBe("setup");
  });
});

describe("oauthSubject", () => {
  for (const source of [
    "session",
    "session-file",
    "device-flow",
    "future-cli-source",
  ])
    it(`accepts an authenticated ${source} source`, () => {
      fakeSync({
        stdout: JSON.stringify({
          authenticated: true,
          source,
          user_id: "user-1",
        }),
      });
      expect(oauthSubject("https://my.orq.ai")).toEqual({
        user_id: "user-1",
        workspace: null,
        project: null,
      });
    });

  it("rejects an unauthenticated CLI", async () => {
    fakeSync({
      stdout: JSON.stringify({
        authenticated: false,
        source: "device-flow",
        user_id: "user-1",
      }),
    });
    expect(
      (await catchError(() => oauthSubject("https://my.orq.ai"))).message,
    ).toContain("sign-in needs attention");
  });

  for (const [stderr, kind, message] of [
    [
      "OAuth refresh token expired or was revoked; run orq auth login",
      "authentication",
      "sign-in needs attention",
    ],
    ["HTTP 503 service unavailable", "unavailable", "Try again shortly"],
  ] as const)
    it(`classifies a failing whoami as ${kind}`, async () => {
      fakeSync({ returncode: 1, stderr });
      const error = await catchError(() => oauthSubject("https://my.orq.ai"));
      expect(error.message).toContain(message);
      expect(error.failureKind).toBe(kind);
    });

  for (const stdout of [
    "{}",
    '{"authenticated":true}',
    '{"authenticated":"yes","user_id":"u"}',
  ])
    it(`keeps unknown identity ${stdout} unavailable`, async () => {
      fakeSync({ stdout });
      const error = await catchError(() => oauthSubject("https://my.orq.ai"));
      expect(error.failureKind).toBe("unavailable");
      expect(error.message).toContain("Try again shortly");
    });
});

describe("OrqCLIError", () => {
  for (const [message, expected] of [
    ["The Orq CLI OAuth sign-in needs attention.", "authentication"],
    ["not signed in; run orq auth login", "authentication"],
    ["missing API key", "authentication"],
    ["The orq CLI is not installed.", "setup"],
    ["connection refused", "unavailable"],
  ] as const)
    it(`infers ${expected} from "${message}"`, () => {
      expect(new OrqCLIError(message).failureKind).toBe(expected);
    });

  for (const kind of ["setup", "unavailable"] as const)
    it(`lets an explicit ${kind} win`, () => {
      expect(
        new OrqCLIError("not signed in; run orq auth login", {
          failureKind: kind,
        }).failureKind,
      ).toBe(kind);
    });
});

describe("CLI OAuth Orq client", () => {
  it("trace query uses JSON stdin, scope flags, hooks and no env credentials", async () => {
    fakeAsync('{"search":{"data":[]}}');
    process.env.ORQ_API_KEY = "must-not-be-forwarded";
    process.env.ORQ_PROFILE = "must-not-be-forwarded-either";
    const [client] = buildCliOauthClients(
      "https://orq.example",
      "acme",
      "project-1",
    );
    const captured: [string, unknown][] = [];
    client.registerAfterSuccessHook((ctx, res) =>
      captured.push([ctx.operationId, res.json()]),
    );
    client.registerAfterSuccessHook({
      afterSuccess: (ctx, res) => captured.push([ctx.operationId, res.json()]),
    });
    const result = await client.traces.queryAsync({
      from: new Date("2026-01-02T00:00:00Z"),
      to: new Date("2026-01-03T00:00:00Z"),
      oql: 'operation = "chat"',
      limit: 25,
      pageToken: "page-2",
      timeoutMs: 30000,
    });
    expect(result).toEqual({ search: { data: [] } });
    expect(captured).toEqual([
      ["TracesQueryOql", { search: { data: [] } }],
      ["TracesQueryOql", { search: { data: [] } }],
    ]);
    expect(calls[0]?.args).toEqual([
      "/usr/local/bin/orq",
      "--no-input",
      "--output-format",
      "json",
      "--profile",
      "",
      "--server",
      "https://orq.example",
      "--workspace",
      "acme",
      "--project",
      "project-1",
      "traces",
      "query-oql",
      "--stdin",
    ]);
    expect(body()).toEqual({
      from: "2026-01-02T00:00:00+00:00",
      to: "2026-01-03T00:00:00+00:00",
      oql: 'operation = "chat"',
      limit: 25,
      page_token: "page-2",
    });
    expect(calls[0]?.options.env).not.toHaveProperty("ORQ_API_KEY");
    expect(calls[0]?.options.env).not.toHaveProperty("ORQ_PROFILE");
  });

  it("routes facets, projects, chat, embeddings and responses", async () => {
    fakeAsync((args) =>
      args.includes("chat")
        ? '{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":2}}'
        : args.includes("embeddings")
          ? '{"data":[{"embedding":[0.1,0.2]}],"usage":{"prompt_tokens":2}}'
          : '{"data":[],"usage":{"input_tokens":1}}',
    );
    const [orq, llm] = buildCliOauthClients();
    await orq.traces.listFacetValuesAsync({
      field: "project_id",
      from: new Date("2026-01-01T00:00:00Z"),
      limit: 12,
    });
    await orq.projects.listAsync({ limit: 100, startingAfter: "p1" });
    const chat = (await llm.chat.completions.create({
      model: "openai/gpt-5.6-luna",
      messages: [{ role: "user", content: "hi" }],
    })) as {
      choices: { message: { content: string } }[];
      usage: { prompt_tokens: number };
    };
    const embeddings = (await llm.embeddings.create({
      model: "openai/text-embedding-3-small",
      input: ["one", "two"],
    })) as { data: { embedding: number[] }[] };
    const response = (await llm.responses.create({
      model: "openai/gpt-5.6-luna",
      input: "hello",
    })) as { usage: { input_tokens: number } };
    expect(calls[0]?.args.slice(-7)).toEqual([
      "traces",
      "list-facet-values",
      "project_id",
      "--from",
      "2026-01-01T00:00:00+00:00",
      "--limit",
      "12",
    ]);
    expect(calls[1]?.args.slice(-6)).toEqual([
      "projects",
      "list",
      "--limit",
      "100",
      "--starting-after",
      "p1",
    ]);
    expect(calls[2]?.args.slice(-3)).toEqual(["chat", "create", "--stdin"]);
    expect(body(2).model).toBe("openai/gpt-5.6-luna");
    expect(calls[3]?.args.slice(-3)).toEqual([
      "embeddings",
      "create",
      "--stdin",
    ]);
    expect(body(3).input).toEqual(["one", "two"]);
    expect(calls[4]?.args.slice(-3)).toEqual([
      "responses",
      "create",
      "--stdin",
    ]);
    expect(chat.choices[0]?.message.content).toBe("ok");
    expect(chat.usage.prompt_tokens).toBe(2);
    expect(embeddings.data[0]?.embedding).toEqual([0.1, 0.2]);
    expect(response.usage.input_tokens).toBe(1);
  });
});
