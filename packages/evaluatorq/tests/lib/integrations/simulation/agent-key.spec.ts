import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(
  new URL("../../fixtures/agent-key-run.ts", import.meta.url),
);

async function run(mode: string, env: Record<string, string> = {}) {
  const { ORQ_BASE_URL, ROUTER_BASE_URL, ...rest } = process.env;
  const proc = Bun.spawn(["bun", fixture, mode], {
    env: { ...rest, ORQ_API_KEY: "test-key", ORQ_DISABLE_TRACING: "1", ...env },
    stdout: "pipe",
    stderr: "ignore",
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  const line = stdout.trim().split("\n").at(-1) ?? "[]";
  return JSON.parse(line) as { taskId?: string; serverURL: string }[];
}

describe("agentKey targets", () => {
  test.each(["wrap", "simulate"])(
    "%s keeps rows with the same opener in separate conversations",
    async (mode) => {
      const calls = await run(mode);

      expect(calls.map((call) => call.taskId ?? null)).toEqual([
        null,
        "task-1",
        null,
        "task-3",
      ]);
    },
    15_000,
  );

  test("reach the host of a ROUTER_BASE_URL set on its own", async () => {
    const calls = await run("wrap", {
      ROUTER_BASE_URL: "https://staging.example/v3/router",
    });

    expect(calls[0]?.serverURL).toBe("https://staging.example");
  }, 15_000);
});
