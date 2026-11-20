import { esc } from "../common/reports/html-helpers.js";
import type { RendererRegistry } from "../common/reports/render.js";
import {
  expandedSections,
  type StandaloneItem,
} from "../common/reports/standalone.js";
import { pythonStrip } from "../common/sanitize.js";
import type { ReportSection } from "../contracts.js";
import type { ReportResult } from "../integrations/simulation/reports/helpers.js";
import { simulationIndividualEntries } from "../integrations/simulation/reports/sections.js";
import type { SimulationRun } from "../integrations/simulation/run-store.js";

export type ReportSections = ReadonlyMap<ReportSection["kind"], ReportSection>;
export async function renderSections(
  byKind: ReportSections,
  renderers: RendererRegistry,
  kinds: readonly ReportSection["kind"][],
): Promise<string> {
  const parts: string[] = [];
  for (const kind of kinds) {
    const section = byKind.get(kind),
      render = renderers[kind];
    if (section && render)
      parts.push(
        `<div id="section-${esc(kind)}">${await render(section)}</div>`,
      );
  }
  return parts.join("");
}
export function reportTabs(
  group: string,
  items: readonly StandaloneItem[],
  options: {
    active?: string | null;
    standalone?: boolean;
    brief?: string;
  } = {},
): string {
  if (options.standalone)
    return expandedSections(group, items, { brief: options.brief });
  const live = items.filter(([, body]) => body && pythonStrip(body));
  if (!live.length) return "";
  const requested = live.findIndex(([label]) => label === options.active),
    checkedIndex = requested < 0 ? 0 : requested,
    radios: string[] = [],
    labels: string[] = [],
    panels: string[] = [];
  for (const [index, [label, body, labelHtml]] of live.entries()) {
    const id = `${group}-${index}`,
      checked = index === checkedIndex ? " checked" : "";
    radios.push(
      `<input class="tab-radio" type="radio" name="${esc(group)}" id="${esc(id)}"${checked}>`,
    );
    labels.push(
      `<label class="tab-label" for="${esc(id)}">${labelHtml ?? esc(label)}</label>`,
    );
    panels.push(`<section class="tab-panel">${body}</section>`);
  }
  return `<div class="tabs">${radios.join("")}<div class="tab-bar">${labels.join("")}</div><div class="tab-panels">${panels.join("")}</div></div>`;
}
export function stableSimulationEntries(
  run: Pick<SimulationRun, "results">,
  rows: readonly ReportResult[],
): Record<string, unknown>[] {
  const indexes = new Map<ReportResult, number>(
    run.results.map((result, index) => [result, index]),
  );
  return simulationIndividualEntries(rows).map((entry, index) => {
    const result = rows[index],
      fullIndex = result ? indexes.get(result) : undefined;
    if (fullIndex === undefined)
      throw new RangeError(
        "Filtered simulation result is not part of the saved run",
      );
    return { ...entry, index: fullIndex };
  });
}
