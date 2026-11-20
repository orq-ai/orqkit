import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resolveRouterBaseUrl } from "../../../../src/lib/integrations/simulation/defaults.js";

describe("resolveRouterBaseUrl", () => {
  const original = {
    orq: process.env.ORQ_BASE_URL,
    router: process.env.ROUTER_BASE_URL,
  };

  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  };

  beforeEach(() => {
    delete process.env.ORQ_BASE_URL;
    delete process.env.ROUTER_BASE_URL;
  });

  afterEach(() => {
    restore("ORQ_BASE_URL", original.orq);
    restore("ROUTER_BASE_URL", original.router);
  });

  test("defaults to the production router", () => {
    expect(resolveRouterBaseUrl()).toBe("https://my.orq.ai/v3/router");
  });

  test("appends the router path to ORQ_BASE_URL", () => {
    process.env.ORQ_BASE_URL = "https://staging.orq.ai/";
    expect(resolveRouterBaseUrl()).toBe("https://staging.orq.ai/v3/router");
  });

  test("does not double the path when ORQ_BASE_URL already has it", () => {
    process.env.ORQ_BASE_URL = "https://staging.orq.ai/v3/router/";
    expect(resolveRouterBaseUrl()).toBe("https://staging.orq.ai/v3/router");
  });

  test("ORQ_BASE_URL wins over ROUTER_BASE_URL", () => {
    process.env.ORQ_BASE_URL = "https://a.example";
    process.env.ROUTER_BASE_URL = "https://b.example/v3/router";
    expect(resolveRouterBaseUrl()).toBe("https://a.example/v3/router");
  });

  test("invalid deprecated router URLs fail before a request", () => {
    for (const value of [
      "my.staging.orq.ai/v3/router",
      "ftp://example.com/router",
    ]) {
      process.env.ROUTER_BASE_URL = value;
      expect(() => resolveRouterBaseUrl()).toThrow(
        "ROUTER_BASE_URL is not a valid URL",
      );
    }
  });

  test("ROUTER_BASE_URL still applies on its own", () => {
    process.env.ROUTER_BASE_URL = "https://b.example/custom";
    expect(resolveRouterBaseUrl()).toBe("https://b.example/custom");
  });
});

test("a fresh process warns once specifically when both base variables are set", () => {
  const module = new URL(
    "../../../../src/lib/integrations/simulation/defaults.ts",
    import.meta.url,
  ).href;
  const result = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `import {resolveRouterBaseUrl} from ${JSON.stringify(module)};resolveRouterBaseUrl();resolveRouterBaseUrl();`,
    ],
    {
      env: {
        ...process.env,
        ORQ_BASE_URL: "https://platform.example",
        ROUTER_BASE_URL: "https://proxy.example/v3/router",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(result.exitCode).toBe(0);
  const stderr = new TextDecoder().decode(result.stderr);
  expect(
    stderr.split("ROUTER_BASE_URL is ignored because ORQ_BASE_URL is also set")
      .length - 1,
  ).toBe(1);
});
