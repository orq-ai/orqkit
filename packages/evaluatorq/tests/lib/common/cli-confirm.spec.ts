import { expect, test } from "bun:test";

import { confirmCliRun } from "../../../src/lib/common/cli-confirm.js";

test("only interactive runs without --yes request confirmation", async () => {
  let prompts = 0;
  const confirm = () => {
    prompts++;
    return false;
  };
  expect(await confirmCliRun(false, { stdinIsTTY: true, confirm })).toBe(false);
  expect(await confirmCliRun(true, { stdinIsTTY: true, confirm })).toBe(true);
  expect(await confirmCliRun(false, { stdinIsTTY: false, confirm })).toBe(true);
  expect(prompts).toBe(1);
});
