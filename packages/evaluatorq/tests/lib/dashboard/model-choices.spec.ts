import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";

import * as catalogue from "../../../src/lib/common/model-catalogue.js";

const calls: Array<{ fn: string; client: unknown; arg: unknown }> = [];
let fail: Error | null = null;

beforeEach(() => {
  spyOn(catalogue, "modelsByProvider").mockImplementation(
    async (client, options) => {
      calls.push({ fn: "modelsByProvider", client, arg: options });
      if (fail) throw fail;
      return { openai: ["openai/gpt-5-mini"] };
    },
  );
  spyOn(catalogue, "getModelInfo").mockImplementation(async (model, client) => {
    calls.push({ fn: "getModelInfo", client, arg: model });
    if (fail) throw fail;
    return { provider: "openai", model } as unknown as catalogue.ModelInfo;
  });
});
afterEach(() => mock.restore());

const { DashboardAuth } = await import("../../../src/lib/dashboard/auth.js");
const { catalogueClient, catalogueEntry, modelGroups } = await import(
  "../../../src/lib/dashboard/model-choices.js"
);

const auth = new DashboardAuth("api_key", "test-key", "https://orq.example");
const saved = { key: process.env.ORQ_API_KEY, url: process.env.ORQ_BASE_URL };

beforeEach(() => {
  calls.length = 0;
  fail = null;
  delete process.env.ORQ_API_KEY;
  delete process.env.ORQ_BASE_URL;
});
afterEach(() => {
  for (const [name, value] of [
    ["ORQ_API_KEY", saved.key],
    ["ORQ_BASE_URL", saved.url],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("catalogueClient", () => {
  it("builds an Orq-routed client from the dashboard credentials", async () => {
    const client = (await catalogueClient(auth)) as {
      baseURL: string;
      maxRetries: number;
    };
    expect(client.baseURL).toBe("https://orq.example/v3/router");
    expect(client.maxRetries).toBe(0);
  });
});

describe("modelGroups", () => {
  it("passes the kind through and returns the grouping", async () => {
    expect(await modelGroups(auth, "embedding")).toEqual({
      openai: ["openai/gpt-5-mini"],
    });
    expect(calls[0]?.arg).toEqual({ kind: "embedding" });
  });

  it("falls back to an empty grouping when the catalogue fails", async () => {
    fail = new Error("down");
    expect(await modelGroups(auth, "chat")).toEqual({});
  });

  it("falls back when no credentials resolve", async () => {
    const none = new DashboardAuth("environment", null, "https://orq.example");
    expect(await modelGroups(none, "chat")).toEqual({});
    expect(calls).toHaveLength(0);
  });
});

describe("catalogueEntry", () => {
  it("returns the entry for a listed model", async () => {
    expect(await catalogueEntry(auth, "openai/gpt-5-mini")).toEqual({
      provider: "openai",
      model: "openai/gpt-5-mini",
    } as never);
  });

  it("returns null when the catalogue fails", async () => {
    fail = new Error("down");
    expect(await catalogueEntry(auth, "openai/gpt-5-mini")).toBeNull();
  });
});
