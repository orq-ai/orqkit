import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { configuredOrqHost } from "../../src/lib/orq-host.js";
import { getOtlpEndpoint } from "../../src/lib/tracing/setup.js";

const fixture = fileURLToPath(
  new URL("./fixtures/orq-client-run.ts", import.meta.url),
);

const NAMES = [
  "ORQ_BASE_URL",
  "ROUTER_BASE_URL",
  "ORQ_API_KEY",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
];

describe("configuredOrqHost", () => {
  const saved = new Map(NAMES.map((name) => [name, process.env[name]]));

  beforeEach(() => {
    for (const name of NAMES) {
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  test("is undefined when nothing is set", () => {
    expect(configuredOrqHost()).toBeUndefined();
  });

  test.each([
    ["https://a.example", "https://a.example"],
    ["https://a.example/", "https://a.example"],
    ["https://a.example/v3/router/", "https://a.example"],
  ])("ORQ_BASE_URL %s gives %s", (value, want) => {
    process.env.ORQ_BASE_URL = value;
    expect(configuredOrqHost()).toBe(want);
  });

  test.each([
    "https://b.example/v3/router",
    "https://b.example/v2/router",
    "https://b.example/custom/",
  ])("ROUTER_BASE_URL %s gives its origin", (value) => {
    process.env.ROUTER_BASE_URL = value;
    expect(configuredOrqHost()).toBe("https://b.example");
  });

  test("ORQ_BASE_URL wins over ROUTER_BASE_URL", () => {
    process.env.ORQ_BASE_URL = "https://a.example";
    process.env.ROUTER_BASE_URL = "https://b.example/v3/router";
    expect(configuredOrqHost()).toBe("https://a.example");
  });

  test.each([
    ["https://gw.example/orq/v3/router", "https://gw.example/orq"],
    ["https://gw.example/orq/v2/router/", "https://gw.example/orq"],
  ])("ROUTER_BASE_URL %s keeps its prefix", (value, want) => {
    process.env.ROUTER_BASE_URL = value;
    expect(configuredOrqHost()).toBe(want);
  });

  test.each([
    "not a url",
    "my.staging.orq.ai/v3/router",
    "localhost:3000/v3/router",
    "ftp://b.example/v3/router",
  ])("ROUTER_BASE_URL %s raises by name", (value) => {
    process.env.ROUTER_BASE_URL = value;
    expect(() => configuredOrqHost()).toThrow("ROUTER_BASE_URL");
  });

  test("tracing keeps the gateway prefix the other clients use", () => {
    process.env.ORQ_API_KEY = "test-key";
    process.env.ROUTER_BASE_URL = "https://gw.example/orq/v3/router";
    expect(getOtlpEndpoint()).toBe("https://gw.example/orq/v2/otel");
  });

  test.each([
    ["ROUTER_BASE_URL", "my.staging.orq.ai/v3/router"],
    ["ORQ_BASE_URL", "my.staging.orq.ai"],
  ])(
    "tracing turns off rather than send the key to production when %s is %s",
    (name, value) => {
      process.env.ORQ_API_KEY = "test-key";
      process.env[name] = value;
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(getOtlpEndpoint()).toBeUndefined();
        expect(String(warn.mock.calls[0]?.[0])).toContain(name);
      } finally {
        warn.mockRestore();
      }
    },
  );

  test("tracing derives its endpoint from a ROUTER_BASE_URL set on its own", () => {
    process.env.ORQ_API_KEY = "test-key";
    process.env.ROUTER_BASE_URL = "https://my.staging.orq.ai/v3/router";
    expect(getOtlpEndpoint()).toBe("https://api.staging.orq.ai/v2/otel");
  });

  test("tracing defaults to production when nothing is set", () => {
    process.env.ORQ_API_KEY = "test-key";
    expect(getOtlpEndpoint()).toBe("https://api.orq.ai/v2/otel");
  });
});

describe("SDK clients", () => {
  async function run(mode: string, env: Record<string, string> = {}) {
    const inherited = { ...process.env };
    for (const name of NAMES) {
      delete inherited[name];
    }
    const proc = Bun.spawn(["bun", fixture, mode], {
      env: {
        ...inherited,
        ORQ_API_KEY: "test-key",
        ORQ_DISABLE_TRACING: "1",
        ...env,
      },
      stdout: "pipe",
      stderr: "ignore",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as {
      rows: number;
      serverURLs: string[];
    };
  }

  test.each(["dataset", "deployment"])(
    "the %s client reaches the host of a ROUTER_BASE_URL set on its own",
    async (mode) => {
      const { serverURLs } = await run(mode, {
        ROUTER_BASE_URL: "https://staging.example/v3/router",
      });

      expect(serverURLs).toEqual(["https://staging.example"]);
    },
    15_000,
  );

  test.each(["dataset", "deployment"])(
    "the %s client defaults to production",
    async (mode) => {
      const { serverURLs } = await run(mode);

      expect(serverURLs).toEqual(["https://my.orq.ai"]);
    },
    15_000,
  );

  test("inline data with a key runs without the SDK installed", async () => {
    const { rows, serverURLs } = await run("inline-without-sdk");

    expect(rows).toBe(1);
    expect(serverURLs).toEqual([]);
  }, 15_000);
});
