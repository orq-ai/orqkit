import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(
  new URL("../../fixtures/agent-key-run.ts", import.meta.url),
);

async function run(mode: string, env: Record<string, string> = {}) {
  const inherited = { ...process.env };
  delete inherited.ORQ_BASE_URL;
  delete inherited.ROUTER_BASE_URL;
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
  const line = stdout.trim().split("\n").at(-1) ?? "{}";
  return JSON.parse(line) as {
    calls: { taskId?: string; serverURL: string }[];
    reasons: string[];
  };
}

const taskIds = (calls: { taskId?: string }[]) =>
  calls.map((call) => call.taskId ?? null);

describe("agentKey targets", () => {
  test.each(["wrap", "simulate", "shared-callback"])(
    "%s keeps rows with the same opener in separate conversations",
    async (mode) => {
      const { calls } = await run(mode);

      expect(taskIds(calls)).toEqual([null, "task-1", null, "task-2"]);
    },
    15_000,
  );

  test("a shared fromOrqAgent keeps overlapping rows apart", async () => {
    const { calls } = await run("parallel");

    const continued = taskIds(calls).filter(Boolean).sort();
    expect(calls).toHaveLength(4);
    expect(continued).toEqual(["task-1", "task-2"]);
  }, 15_000);

  test("a later turn keeps the task when the stream repeats no id", async () => {
    const { calls } = await run("resume-without-id");

    expect(taskIds(calls)).toEqual([null, "task-1", "task-1"]);
  }, 15_000);

  test("a caller with no conversation id continues by opener and restarts on a first turn", async () => {
    const { calls } = await run("direct-callers");

    expect(taskIds(calls)).toEqual([null, "task-1", null]);
  }, 15_000);

  test("a second turn with no task id fails the row", async () => {
    const { calls, reasons } = await run("no-task-id");

    expect(calls).toHaveLength(1);
    expect(reasons[0]).toContain("no task id");
  }, 15_000);

  test("a one-turn row keeps its reply when the stream gives no task id", async () => {
    const { calls, reasons } = await run("no-task-id-one-turn");

    expect(calls).toHaveLength(1);
    expect(reasons[0]).not.toContain("no task id");
  }, 15_000);

  test("reach the host of a ROUTER_BASE_URL set on its own", async () => {
    const { calls } = await run("wrap", {
      ROUTER_BASE_URL: "https://staging.example/v3/router",
    });

    expect(calls[0]?.serverURL).toBe("https://staging.example");
  }, 15_000);
});
