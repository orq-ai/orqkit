import { afterEach, describe, expect, it, mock } from "bun:test";

import { UnexpectedClientError } from "@orq-ai/node/models/errors/httpclienterrors.js";

import { OrqCLIError } from "../../../src/lib/common/cli-oauth.js";
import { authStatus, DashboardAuth } from "../../../src/lib/dashboard/auth.js";
import type { DashboardSettings } from "../../../src/lib/trace-finder/settings.js";

const env = () => ({ orqAuthMethod: "environment" }) as DashboardSettings;
const keyed = new DashboardAuth("environment", "test-key", "https://my.orq.ai");
const base = {
  settings: async () => env(),
  resolve: async () => keyed,
};
const quiet = { warn: console.warn, error: console.error };
afterEach(() => {
  console.warn = quiet.warn;
  console.error = quiet.error;
});
const silence = () => {
  const warn = mock(() => {});
  const error = mock(() => {});
  console.warn = warn;
  console.error = error;
  return { warn, error };
};

describe("authStatus", () => {
  it("asks for action when the environment key is missing", async () => {
    const result = await authStatus({
      settings: base.settings,
      resolve: async () =>
        new DashboardAuth("environment", null, "https://my.orq.ai"),
    });
    expect(result.status).toBe("action");
    expect(result.message).toContain("ORQ_API_KEY is not set");
  });

  it("reports a rejected key without leaking provider text", async () => {
    const rejected = Object.assign(
      new Error("provider response includes a private value"),
      { statusCode: 401 },
    );
    const result = await authStatus({
      ...base,
      clients: async () => {
        throw rejected;
      },
    });
    expect(result.status).toBe("action");
    expect(result.message).toContain("was rejected");
    expect(JSON.stringify(result)).not.toContain("private value");
    expect(JSON.stringify(result)).not.toContain("test-key");
  });

  it.each([
    [
      "a probe timeout",
      Object.assign(new Error("timed out"), { name: "TimeoutError" }),
      "error",
    ],
    ["a TypeError bug", new TypeError("x is undefined"), "error"],
    ["a fetch network failure", new TypeError("fetch failed"), "unavailable"],
  ])("treats %s like Python does", async (_label, thrown, expected) => {
    silence();
    const result = await authStatus({
      ...base,
      clients: async () => {
        throw thrown;
      },
    });
    expect(result.status as string).toBe(expected);
  });

  it("separates a programming defect from an outage", async () => {
    const { error } = silence();
    const result = await authStatus({
      ...base,
      clients: async () => {
        throw new RangeError("programming defect");
      },
    });
    expect(result.status).toBe("error");
    expect(result.message).toContain("Check the dashboard logs");
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("marks an unreachable Orq as unavailable with one warning", async () => {
    const { warn } = silence();
    const result = await authStatus({
      ...base,
      clients: async () => {
        throw new TypeError("fetch failed");
      },
    });
    expect(result.status).toBe("unavailable");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("recognizes CLI outages and SDK errors without a custom name", async () => {
    class SDKError extends Error {}
    const { warn, error } = silence();
    for (const failure of [
      new OrqCLIError("connection refused", { failureKind: "unavailable" }),
      new SDKError("connection refused"),
      new UnexpectedClientError("connection refused"),
    ]) {
      const result = await authStatus({
        ...base,
        clients: async () => {
          throw failure;
        },
      });
      expect(result.status).toBe("unavailable");
    }
    expect(warn).toHaveBeenCalledTimes(3);
    expect(error).not.toHaveBeenCalled();
  });

  it("asks for action when the CLI OAuth sign-in is missing", async () => {
    const result = await authStatus({
      settings: async () =>
        ({ orqAuthMethod: "cli_oauth" }) as DashboardSettings,
      resolve: async () =>
        new DashboardAuth("cli_oauth", null, "https://my.orq.ai"),
      clients: async () => {
        throw new Error(
          "The orq CLI is not installed. Install it and sign in before using CLI OAuth.",
        );
      },
    });
    expect(result.status).toBe("action");
    expect(result.message).toContain("CLI OAuth was rejected");
  });

  it("asks for action when resolving the credential fails", async () => {
    const result = await authStatus({
      settings: base.settings,
      resolve: async () => {
        throw new Error("profile has no usable API key");
      },
    });
    expect(result).toEqual({
      status: "action",
      method: "environment",
      message: "profile has no usable API key",
    });
  });

  it("closes both clients and still reports valid", async () => {
    const { warn } = silence();
    const closed: string[] = [];
    const orq = {
      traces: { listFacetValues: async () => null },
      close: async () => {
        closed.push("orq");
        throw new Error("orq close failed");
      },
    };
    const llm = {
      close: async () => {
        closed.push("llm");
        throw new Error("llm close failed");
      },
    };
    const result = await authStatus({
      ...base,
      clients: async () => [orq, llm] as const,
    });
    expect(result).toEqual({ status: "valid", method: "environment" });
    expect(closed).toEqual(["orq", "llm"]);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
