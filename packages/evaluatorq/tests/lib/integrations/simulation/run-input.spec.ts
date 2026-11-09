import { describe, expect, spyOn, test } from "bun:test";

import { failureReason } from "../../../../src/lib/integrations/simulation/evaluators/index.js";
import type { FirstMessageGenerator } from "../../../../src/lib/integrations/simulation/generators/first-message-generator.js";
import { runSimulationInput } from "../../../../src/lib/integrations/simulation/runner/run-input.js";
import { SimulationRunner } from "../../../../src/lib/integrations/simulation/runner/simulation.js";
import { generateDatapoint } from "../../../../src/lib/integrations/simulation/utils/prompt-builders.js";
import { finishTurn, makeFakeClient } from "./fake-client.js";

const persona = {
  name: "User",
  patience: 0.5,
  assertiveness: 0.5,
  politeness: 0.5,
  technical_level: 0.5,
  communication_style: "casual" as const,
  background: "bg",
};
const scenario = { name: "Refund", goal: "Get a refund", criteria: [] };

const firstMessages = (generate: () => Promise<string>) => () =>
  ({ generate }) as unknown as FirstMessageGenerator;

function runner(targetCallback: () => Promise<string> = async () => "reply") {
  const { client } = makeFakeClient({ judge: () => finishTurn([]) });
  return new SimulationRunner({ targetCallback, client });
}

describe("runSimulationInput row timeout", () => {
  test("a first message that never comes times the row out", async () => {
    const started = Date.now();

    const result = await runSimulationInput(
      { persona, scenario },
      runner(),
      1,
      firstMessages(() => new Promise(() => {})),
      100,
    );

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.terminated_by).toBe("timeout");
    expect(result.metadata.persona).toBe("User");
    expect(failureReason(result)).toBe("Simulation timed out after 100ms");
  });

  test("the first message's time counts against the conversation", async () => {
    const row = runner();
    const conversation = spyOn(row, "runWithTimeout");

    await runSimulationInput(
      { persona, scenario },
      row,
      1,
      firstMessages(() => Bun.sleep(50).then(() => "hello")),
      5_000,
    );

    const [, , timeoutMs, elapsedMs] = conversation.mock.calls[0] ?? [];
    expect(timeoutMs).toBe(5_000);
    expect(elapsedMs).toBeGreaterThanOrEqual(40);
  });

  test("a conversation only gets what is left of the limit", async () => {
    const started = Date.now();

    const result = await runner(() => new Promise(() => {})).runWithTimeout(
      generateDatapoint(persona, scenario, "hello"),
      1,
      5_000,
      4_950,
    );

    // A fresh limit would take the full 5 seconds, far past this margin.
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(result.terminated_by).toBe("timeout");
    expect(failureReason(result)).toBe("Simulation timed out after 5000ms");
  });

  test("a failed first message still reports its own reason", async () => {
    const result = await runSimulationInput(
      { persona, scenario },
      runner(),
      1,
      firstMessages(() => Promise.reject(new Error("no model"))),
      100,
    );

    expect(result.terminated_by).toBe("error");
    expect(failureReason(result)).toBe("First message failed: no model");
  });

  test("a zero timeout means no limit on the first message", async () => {
    const result = await runSimulationInput(
      { persona, scenario },
      runner(),
      1,
      firstMessages(() => Bun.sleep(20).then(() => "hello")),
      0,
    );

    expect(result.terminated_by).toBe("judge");
  });
});
