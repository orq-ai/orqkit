import { afterAll, beforeAll, expect, it } from "bun:test";
import { createHash } from "node:crypto";

import {
  dashboardCss,
  page,
  sidebarHtml,
} from "../../../src/lib/dashboard/shell.js";
import golden from "./fixtures/shell-golden.json" with { type: "json" };

// Golden HTML comes from Python shell.py; CSS fingerprints reflect TS comment normalization and the malformed comment correction.
const saved = process.env.EVALUATORQ_DASHBOARD_SETTINGS;
beforeAll(() => {
  process.env.EVALUATORQ_DASHBOARD_SETTINGS = "/nonexistent/s.json";
});
afterAll(() => {
  if (saved === undefined) delete process.env.EVALUATORQ_DASHBOARD_SETTINGS;
  else process.env.EVALUATORQ_DASHBOARD_SETTINGS = saved;
});

it("serves the checked dashboard stylesheet", () => {
  expect(createHash("sha256").update(dashboardCss()).digest("hex")).toBe(
    golden.css_sha,
  );
});

it("renders pages like shell.py", async () => {
  expect(
    await page("Runs <x>", "<p>b</p>", {
      activeSurface: "sim",
      actionsHtml: "<a>Export</a>",
    }),
  ).toBe(golden.plain);
  expect(
    await page("Report", '<div data-vega-for="c"></div>', {
      activeNav: "settings",
      backHtml: "<a>Back</a>",
      bodyClass: "wide",
      headHtml: "<meta name=x>",
      topbar: false,
    }),
  ).toBe(golden.bare);
  expect(sidebarHtml("compression-inspector", true)).toBe(golden.sidebar_ci);
});
