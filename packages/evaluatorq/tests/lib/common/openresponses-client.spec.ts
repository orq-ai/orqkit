import { expect, test } from "bun:test";

import OpenAI from "openai";

import { buildSimulationClient } from "../../../src/lib/integrations/openresponses/client.js";

test("injected simulation client remains caller-owned and disables SDK retries", async () => {
  const input = new OpenAI({
    apiKey: "synthetic",
    baseURL: "http://127.0.0.1:1",
    maxRetries: 3,
  });
  const resolved = await buildSimulationClient(input);
  expect(resolved.owned).toBe(false);
  expect(resolved.client.maxRetries).toBe(0);
  expect(input.maxRetries).toBe(3);
  const retained = await buildSimulationClient(input, { maxRetries: null });
  expect(retained.client).toBe(input);
});
