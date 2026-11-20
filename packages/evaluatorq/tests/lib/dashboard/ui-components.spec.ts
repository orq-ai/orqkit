// Ported from res-697 tests/dashboard/test_ui_components.py and test_dashboard_js_runtime.py.
import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { componentAssets } from "../../../src/lib/dashboard/static-assets.js";

function runNode(script: string, timeout: number) {
  const result = spawnSync("node", [join(import.meta.dir, "js", script)], {
    encoding: "utf8",
    timeout,
  });
  expect(result.status, result.stdout + result.stderr).toBe(0);
}

it("runs the shared component script in a small DOM runtime", () =>
  runNode("ui-components.cjs", 15_000));

it("runs the dashboard event behavior tests", () =>
  runNode("dashboard-runtime.cjs", 60_000));

it("versions component assets by content", () => {
  expect(componentAssets()).toMatch(
    /^<link rel="stylesheet" href="\/static\/ui-components\.css\?v=[0-9a-f]{12}">\n<script src="\/static\/ui-components\.js\?v=[0-9a-f]{12}" defer><\/script>\n$/,
  );
});
