import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { PYTHON_CLI_SCHEMAS } from "../../src/lib/common/python-cli-schemas.js";
import { PYTHON_CONFIG_KEYS } from "../../src/lib/common/python-config-keys.js";
import { PYTHON_SHAPES } from "../../src/lib/common/python-shapes.js";

const python = process.env.EVALUATORQ_PYTHON;

function generated(script: string): Record<string, unknown> {
  const result = spawnSync(
    python as string,
    [join(import.meta.dir, "fixtures", script)],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${script} failed (${result.status}): ${result.stderr}`);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe.skipIf(!python)(
  "pinned Python generators reproduce committed contracts",
  () => {
    test("wire key shapes are current", () => {
      expect(generated("python_shapes.py").models).toEqual(PYTHON_SHAPES);
    }, 30_000);

    test("accepted config keys are current", () => {
      expect(generated("python_config_keys.py").models).toEqual(
        PYTHON_CONFIG_KEYS,
      );
    }, 30_000);

    test("CLI schemas are current", () => {
      expect(generated("python_cli_schemas.py")).toEqual(PYTHON_CLI_SCHEMAS);
    }, 30_000);
  },
);
