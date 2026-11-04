import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const FIXTURE = fileURLToPath(
  new URL("./fixtures/manage-tracing-run.ts", import.meta.url),
);

/** Tracing setup is once per process, so each case needs its own. */
async function tracingStateAfterRun(manageTracing?: string): Promise<string> {
  const { ORQ_API_KEY: _key, ORQ_DISABLE_TRACING: _off, ...env } = process.env;
  const proc = Bun.spawn(
    ["bun", FIXTURE, ...(manageTracing ? [manageTracing] : [])],
    {
      env: { ...env, OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:9" },
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout.match(/tracing=\w+/)?.[0] ?? `no state in: ${stdout}`;
}

describe("manageTracing", () => {
  test("false leaves the caller's tracing running", async () => {
    expect(await tracingStateAfterRun("false")).toBe("tracing=running");
  }, 15_000);

  test("defaults to shutting tracing down", async () => {
    expect(await tracingStateAfterRun()).toBe("tracing=stopped");
  }, 15_000);
});
