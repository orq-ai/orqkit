import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { JudgeAgent } from "../../../../src/lib/integrations/simulation/agents/judge.js";
import { createRouterClient } from "../../../../src/lib/integrations/simulation/client.js";
import {
  FirstMessageGenerator,
  PersonaGenerator,
  ScenarioGenerator,
} from "../../../../src/lib/integrations/simulation/generators/index.js";
import { SimulationRunner } from "../../../../src/lib/integrations/simulation/runner/simulation.js";

const VARS = ["ORQ_API_KEY", "ORQ_BASE_URL", "ROUTER_BASE_URL"] as const;

type WithClient = { client: { baseURL: string; apiKey: string } };

const sites: [string, (apiKey?: string) => unknown][] = [
  ["JudgeAgent", (apiKey) => new JudgeAgent({ apiKey })],
  ["PersonaGenerator", (apiKey) => new PersonaGenerator({ apiKey })],
  ["ScenarioGenerator", (apiKey) => new ScenarioGenerator({ apiKey })],
  ["FirstMessageGenerator", (apiKey) => new FirstMessageGenerator({ apiKey })],
];

describe("createRouterClient", () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of VARS) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of VARS) {
      const value = saved.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  test("reads the key from the environment and points at the router", () => {
    process.env.ORQ_API_KEY = "env-key";
    process.env.ORQ_BASE_URL = "https://staging.example";

    const client = createRouterClient();

    expect(client.apiKey).toBe("env-key");
    expect(client.baseURL).toBe("https://staging.example/v3/router");
  });

  test("an explicit key wins over the environment", () => {
    process.env.ORQ_API_KEY = "env-key";

    expect(createRouterClient("own-key").apiKey).toBe("own-key");
  });

  test("raises without a key, naming the variable", () => {
    expect(() => createRouterClient()).toThrow("ORQ_API_KEY");
  });

  test("an empty key raises instead of using the environment", () => {
    process.env.ORQ_API_KEY = "env-key";

    expect(() => createRouterClient("")).toThrow("ORQ_API_KEY");
  });

  test.each(sites)("%s builds its client this way", (_name, build) => {
    process.env.ORQ_BASE_URL = "https://staging.example";

    const { client } = build("own-key") as WithClient;

    expect(client.apiKey).toBe("own-key");
    expect(client.baseURL).toBe("https://staging.example/v3/router");
  });

  test.each(sites)("%s raises without a key", (_name, build) => {
    expect(() => build()).toThrow("ORQ_API_KEY");
  });

  test("SimulationRunner builds its client this way", () => {
    process.env.ORQ_API_KEY = "env-key";
    process.env.ORQ_BASE_URL = "https://staging.example";
    const runner = new SimulationRunner({
      targetCallback: () => "reply",
    }) as unknown as { getSharedClient(): WithClient["client"] };

    const client = runner.getSharedClient();

    expect(client.apiKey).toBe("env-key");
    expect(client.baseURL).toBe("https://staging.example/v3/router");
    expect(runner.getSharedClient()).toBe(client);
  });
});
