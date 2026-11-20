import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { esc } from "../common/reports/html-helpers.js";
import type { RunManifest } from "../contracts.js";
import type { InsightsRunFields } from "../insights/models.js";
import { runFormScriptTag } from "./insights-run-form.js";
import { snakeJson } from "./insights-views.js";
import { page } from "./shell.js";
import {
  componentAssets,
  STATIC_DIR,
  scriptAsset,
  stylesheetAsset,
} from "./static-assets.js";

const REVIEW_STYLESHEET =
  '<link rel="stylesheet" href="/static/insights-review.css">\n';
const REVIEW_SCRIPT =
  '<script src="/static/insights-review.js" defer></script>\n';

/** Render the review shell; trace content is fetched from the JSON endpoint. */
export async function reviewPage(
  run: InsightsRunFields,
  manifest: RunManifest | null = null,
): Promise<string> {
  let body = await readFile(
    join(STATIC_DIR, "insights-review-template.html"),
    "utf8",
  );
  const runUrl = encodeURIComponent(run.runId);
  body = body
    .replaceAll("REVIEW_URL", esc(`/insights/${runUrl}/review-data.json`))
    .replaceAll(
      '<a href="#" data-act="mock">Insights</a>',
      '<a href="/insights">Insights</a>',
    )
    .replaceAll(
      '<button class="btn" data-act="mock">Export</button>',
      `<a class="btn" href="/insights/${runUrl}/export.json">Export</a>`,
    )
    .replaceAll(
      '<button class="btn" data-act="mock">Re-run</button>',
      `<a class="btn" id="rerun" href="/insights/${runUrl}?rerun=1">Re-run</a>`,
    );
  const progress =
    manifest === null
      ? null
      : {
          status: manifest.status,
          stage: manifest.stage,
          stage_labels: manifest.stageLabels,
          planned_stages: manifest.plannedStages,
          stages: snakeJson(manifest.stages),
          error: manifest.error,
        };
  body = body
    .replaceAll("REVIEW_PROGRESS", esc(JSON.stringify(progress)))
    .replace('<header class="top">', '<header class="top" id="header">');
  return page(run.runName, body, {
    activeNav: "insights",
    bodyClass: "eq-insights-review",
    topbar: false,
    headHtml: `${componentAssets()}${REVIEW_STYLESHEET}${stylesheetAsset("insights-signals.css")}${await runFormScriptTag()}\n${scriptAsset("insights-signals.js")}${REVIEW_SCRIPT}`,
  });
}
