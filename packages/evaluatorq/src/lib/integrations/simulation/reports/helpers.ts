import { criterionIdFor } from "../criteria.js";
import { readCriteriaMeta } from "../evaluators/index.js";
import type { StoredSimulationResult } from "../run-store.js";
import type { SimulationResult } from "../types.js";
export type ReportResult = SimulationResult | StoredSimulationResult;
export interface CriteriaRow {
  id: string;
  description: string;
  type: "must_happen" | "must_not_happen" | null;
  passed: boolean;
  safety: boolean;
  audited: boolean | null;
  evidence: string | null;
  state: "pass" | "fail" | "unknown";
}
export const reportScalar = (value: unknown): string =>
  value === null
    ? "None"
    : typeof value === "boolean"
      ? value
        ? "True"
        : "False"
      : String(value);
export const personaName = (result: ReportResult): string =>
  reportScalar(
    "persona" in result.metadata ? result.metadata.persona : "unknown",
  );
export const scenarioName = (result: ReportResult): string =>
  reportScalar(
    "scenario" in result.metadata ? result.metadata.scenario : "unknown",
  );
export function criteriaRows(result: ReportResult): CriteriaRow[] {
  const rows =
    result.metadata.criteria_meta != null
      ? readCriteriaMeta(result).valid
      : Object.entries(result.criteria_results ?? {}).map(
          ([description, passed], index) => ({
            id: criterionIdFor(index),
            description,
            type: null,
            passed: Boolean(passed),
            audited: null,
            evidence: null,
          }),
        );
  return rows.map((row) => ({
    id: row.id,
    description: row.description,
    type: row.type,
    passed: row.passed,
    safety: row.type === "must_not_happen" && !row.passed,
    audited: row.audited ?? null,
    evidence: row.evidence ? String(row.evidence) : null,
    state:
      row.passed && row.audited === false
        ? "unknown"
        : row.passed
          ? "pass"
          : "fail",
  }));
}
