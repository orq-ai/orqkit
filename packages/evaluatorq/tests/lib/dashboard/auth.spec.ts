import { describe, expect, it } from "bun:test";

import {
  accountIdentity,
  accountLabel,
  authIdentity,
  DashboardAuth,
  resolveDashboardAuth,
  verifiedAccountIdentity,
} from "../../../src/lib/dashboard/auth.js";
import type { DashboardSettings } from "../../../src/lib/trace-finder/settings.js";

// Expected hashes computed by the Python auth.py helpers on the same fields.
const profile = {
  name: "dev",
  apiKey: "sk-test",
  server: "https://my.orq.ai/",
  active: true,
};
const auth = new DashboardAuth(
  "cli_profile",
  "sk-test",
  "https://my.orq.ai/",
  profile,
);
const settings = (k: Partial<DashboardSettings>) => k as DashboardSettings;

describe("dashboard auth", () => {
  it("requires a platform host for proxy-only environment credentials", async () => {
    const saved = {
      ORQ_BASE_URL: process.env.ORQ_BASE_URL,
      ROUTER_BASE_URL: process.env.ROUTER_BASE_URL,
    };
    delete process.env.ORQ_BASE_URL;
    process.env.ROUTER_BASE_URL = "https://proxy.example/custom";
    try {
      for (const orqAuthMethod of ["environment", "cli_oauth"] as const) {
        await expect(
          resolveDashboardAuth(settings({ orqAuthMethod })),
        ).rejects.toThrow("set ORQ_BASE_URL explicitly");
      }
      await expect(
        resolveDashboardAuth(
          settings({ orqAuthMethod: "cli_profile", orqProfile: "dev" }),
          { profiles: [{ ...profile, server: null }] },
        ),
      ).rejects.toThrow("set ORQ_BASE_URL explicitly");
      expect(
        (
          await resolveDashboardAuth(
            settings({ orqAuthMethod: "cli_profile", orqProfile: "dev" }),
            { profiles: [profile] },
          )
        ).baseUrl,
      ).toBe(profile.server);
      expect(
        (
          await resolveDashboardAuth(
            settings({
              orqAuthMethod: "cli_oauth",
              orqOauthServer: "https://explicit.example",
            }),
          )
        ).baseUrl,
      ).toBe("https://explicit.example");
      process.env.ORQ_BASE_URL = "https://platform.example/prefix";
      expect(
        (await resolveDashboardAuth(settings({ orqAuthMethod: "environment" })))
          .baseUrl,
      ).toBe("https://platform.example/prefix");
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("hashes account and scope like Python", () => {
    expect(accountIdentity(auth)).toBe(
      "e266b3da4a57f3c8d9631a1d3ab965ea33c209c027d6fd9bf6f8b90bb1112e2b",
    );
    expect(
      authIdentity(auth, settings({ orqWorkspace: "wé", orqProjectId: null })),
    ).toBe("8f15e83c5280b5fc9566b8bd6b3257eca5dc3c3ad51d7c016f76ec72740be331");
  });

  it("verifies one workspace and falls back to projects on 403", async () => {
    const one = { data: [{ id: "ws1" }], hasMore: false };
    const viaWorkspace = await verifiedAccountIdentity(
      new DashboardAuth("environment", "k", "HTTPS://My.Orq.AI/api/"),
      { workspaces: { list: async () => one }, projects: {} },
    );
    expect(viaWorkspace).toBe(
      "d2f5453675002bf00d2a0138d568ffda61f40f1c544b8764c7be067526fdbb0b",
    );
    const forbidden = Object.assign(new Error("no"), { statusCode: 403 });
    await expect(
      verifiedAccountIdentity(auth, {
        workspaces: { list: async () => Promise.reject(forbidden) },
        projects: {
          list: async () => ({
            data: [{ projectId: "a" }, { projectId: "b" }],
          }),
        },
      }),
    ).rejects.toThrow("did not verify exactly one project");
  });

  it("resolves profiles and rejects masked keys", async () => {
    const resolved = await resolveDashboardAuth(
      settings({ orqAuthMethod: "cli_profile", orqProfile: "dev" }),
      { profiles: [profile] },
    );
    expect(resolved.label).toBe("CLI profile dev");
    expect(accountLabel(resolved)).toBe("dev on my.orq.ai");
    await expect(
      resolveDashboardAuth(
        settings({ orqAuthMethod: "cli_profile", orqProfile: "dev" }),
        {
          profiles: [{ ...profile, apiKey: "sk-***" }],
        },
      ),
    ).rejects.toThrow("has no usable API key");
    const oauth = await resolveDashboardAuth(
      settings({ orqAuthMethod: "cli_oauth", orqOauthServer: null }),
    );
    expect(accountLabel(oauth)).toBe("CLI OAuth on my.orq.ai");
    expect(JSON.stringify(resolved)).not.toContain("sk-test");
  });
});
