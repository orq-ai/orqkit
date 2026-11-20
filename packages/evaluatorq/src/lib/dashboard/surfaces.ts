import { readFile } from "node:fs/promises";

import { exportSimulationHtml } from "../integrations/simulation/reports/export-html.js";
import { exportSimulationMarkdown } from "../integrations/simulation/reports/export-md.js";
import { simulationIndividualEntries } from "../integrations/simulation/reports/sections.js";
import { SimulationRun } from "../integrations/simulation/run-store.js";
import { exportHtml as exportPairwiseHtml } from "../pairwise-reports/export-html.js";
import {
  judgeOrder,
  voteLabel,
  winnerLabel,
} from "../pairwise-reports/sections.js";
import { type PairwiseEntry, PairwiseRun } from "../pairwise-run.js";
import { deliveryMethodStr } from "../redteam/delivery-method-registry.js";
import { exportRedteamHtml } from "../redteam/reports/export-html.js";
import { exportRedteamMarkdown } from "../redteam/reports/export-md.js";
import {
  RedTeamReport,
  type RedTeamResult,
} from "../redteam/reports/models.js";

export type ExportRow = Record<string, unknown>;

export interface SurfaceAdapter<T, R> {
  load: (path: string) => Promise<T>;
  export: (obj: T) => Promise<string>;
  name: (obj: T) => string;
  createdAt: (obj: T) => Date;
  exportMarkdown: ((obj: T) => Promise<string>) | null;
  rows: ((obj: T, filtered: R[]) => ExportRow[]) | null;
}

const readJson = async (path: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(path, "utf8"));

function redteamRows(
  _r: RedTeamReport,
  filtered: RedTeamResult[],
): ExportRow[] {
  return filtered.map((r) => {
    const dms = r.attack.deliveryMethods;
    return {
      ID: r.attack.id,
      Category: r.attack.category,
      Vulnerability: r.attack.vulnerability || "-",
      Technique: r.attack.attackTechnique,
      "Delivery Method": dms?.length
        ? dms.map(deliveryMethodStr).join(", ")
        : "-",
      "Turn Type": r.attack.turnType || "-",
      Domain: r.attack.vulnerabilityDomain || "-",
      Severity: r.attack.severity,
      Result: r.vulnerable
        ? "VULNERABLE"
        : r.vulnerable == null
          ? "NOT EVALUATED"
          : "RESISTANT",
      Source: r.attack.source,
    };
  });
}

function pairwiseRows(
  run: PairwiseRun,
  filtered: PairwiseEntry[],
): ExportRow[] {
  const order = judgeOrder(run);
  return filtered.map((entry, i) => {
    const votes = new Map(entry.comparison.votes.map((v) => [v.model, v]));
    const row: ExportRow = {
      "#": i + 1,
      Question: entry.question,
      Winner: winnerLabel(entry.comparison.winner, run),
    };
    for (const model of order) {
      const vote = votes.get(model);
      row[model] = vote ? voteLabel(vote.vote, run) : "";
    }
    return row;
  });
}

const redteam: SurfaceAdapter<RedTeamReport, RedTeamResult> = {
  load: async (p) => new RedTeamReport(await readJson(p)),
  export: exportRedteamHtml,
  name: (r) => r.description || "Red team report",
  createdAt: (r) => new Date(r.createdAt),
  exportMarkdown: exportRedteamMarkdown,
  rows: redteamRows,
};

const sim: SurfaceAdapter<SimulationRun, SimulationRun["results"][number]> = {
  load: (p) => SimulationRun.load(p),
  export: (run) => exportSimulationHtml(run),
  name: (run) => run.runName,
  createdAt: (run) => new Date(run.createdAt),
  exportMarkdown: (run) =>
    exportSimulationMarkdown(run.results, {
      target: run.targetKind,
      runDate: run.createdAt,
      executiveSummary: run.executiveSummary,
      recommendations: run.recommendations,
    }),
  rows: (_run, filtered) => simulationIndividualEntries(filtered),
};

const pairwise: SurfaceAdapter<PairwiseRun, PairwiseEntry> = {
  load: (p) => PairwiseRun.load(p),
  export: exportPairwiseHtml,
  name: (run) => run.runName,
  createdAt: (run) => new Date(run.createdAt),
  exportMarkdown: null,
  rows: pairwiseRows,
};

export const ADAPTERS: Readonly<Record<string, SurfaceAdapter<never, never>>> =
  {
    redteam: redteam as unknown as SurfaceAdapter<never, never>,
    sim: sim as unknown as SurfaceAdapter<never, never>,
    pairwise: pairwise as unknown as SurfaceAdapter<never, never>,
  };
