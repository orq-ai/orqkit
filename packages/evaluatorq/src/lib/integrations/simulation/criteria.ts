/**
 * Criteria tracking across a simulation.
 *
 * The judge reports per-turn occurrence only. Whether a criterion passed is
 * computed here: must_happen passes if it occurred, must_not_happen passes if
 * it did not. Occurrence is sticky, so a later turn cannot undo it.
 */

import type {
  CriteriaMeta,
  Criterion,
  CriterionVerdict,
  Scenario,
} from "./types.js";

/** Positional ID shown to the judge for the criterion at this index. */
export function criterionIdFor(index: number): string {
  return `criteria_${index}`;
}

export class CriteriaTracker {
  private readonly criteria: Criterion[];
  private readonly ids: string[];
  private readonly occurred = new Map<string, boolean>();
  private readonly seen = new Set<string>();
  private readonly evidenceById = new Map<string, string>();
  private anyAudit = false;

  constructor(scenario: Scenario | undefined) {
    this.criteria = scenario?.criteria ?? [];
    this.ids = this.criteria.map((_, i) => criterionIdFor(i));
    for (const id of this.ids) {
      this.occurred.set(id, false);
    }
  }

  /** True when there is nothing to audit or at least one audit arrived. */
  get verified(): boolean {
    return this.criteria.length === 0 || this.anyAudit;
  }

  get auditedIds(): Set<string> {
    return new Set(this.seen);
  }

  /** IDs that occurred. Occurrence is final, so the judge can skip them. */
  get settledIds(): Set<string> {
    return new Set(this.ids.filter((id) => this.occurred.get(id)));
  }

  get evidence(): Record<string, string> {
    return Object.fromEntries(this.evidenceById);
  }

  get unauditedIds(): string[] {
    return this.ids.filter((id) => !this.seen.has(id));
  }

  /** must_happen criteria that have not occurred yet, and still could. */
  get unconfirmedIds(): string[] {
    return this.ids.filter(
      (id, i) =>
        this.criteria[i]?.type === "must_happen" && !this.occurred.get(id),
    );
  }

  /** Every criterion that does not pass as of now, in criterion order. */
  get brokenIds(): string[] {
    return this.ids.filter((id, i) => {
      const occurred = this.occurred.get(id) ?? false;
      return this.criteria[i]?.type === "must_happen" ? !occurred : occurred;
    });
  }

  /** Broken for certain: an unconfirmed must_happen could still have happened. */
  get confirmedBrokenIds(): string[] {
    const unconfirmed = new Set(this.unconfirmedIds);
    return this.brokenIds.filter((id) => !unconfirmed.has(id));
  }

  observe(verdicts: CriterionVerdict[] | null | undefined): void {
    if (!verdicts || verdicts.length === 0) {
      return;
    }

    const unknown = verdicts
      .map((v) => v.criterion_id)
      .filter((id) => !this.occurred.has(id));
    if (unknown.length > 0) {
      console.warn(
        `CriteriaTracker: ignoring verdicts for unknown criteria: ${unknown.join(", ")}`,
      );
    }

    for (const verdict of verdicts) {
      const id = verdict.criterion_id;
      if (!this.occurred.has(id)) {
        continue;
      }
      this.anyAudit = true;
      this.seen.add(id);
      if (verdict.occurred && !this.occurred.get(id)) {
        this.occurred.set(id, true);
        if (verdict.evidence) {
          this.evidenceById.set(id, verdict.evidence);
        }
      }
    }
  }

  /**
   * Final broken IDs for a run that reached a verdict.
   *
   * With no audit at all the fallback stands and the run stays unverified.
   */
  resolve(fallback: string[]): string[] {
    if (this.criteria.length === 0) {
      return fallback;
    }
    if (!this.anyAudit) {
      console.warn(
        "CriteriaTracker: judge never audited the criteria, this run is unverified",
      );
      return fallback;
    }
    const unaudited = this.unauditedIds;
    if (unaudited.length > 0) {
      console.warn(
        `CriteriaTracker: criteria never audited: ${unaudited.join(", ")}`,
      );
    }
    return this.brokenIds;
  }
}

/** Map each criterion description to whether it passed. */
export function buildCriteriaResults(
  scenario: Scenario | undefined,
  rulesBroken: string[],
): Record<string, boolean> {
  const broken = new Set(rulesBroken);
  const results: Record<string, boolean> = {};
  (scenario?.criteria ?? []).forEach((criterion, i) => {
    results[criterion.description] = !broken.has(criterionIdFor(i));
  });
  return results;
}

/**
 * Per-criterion audit trail for scoring and reporting.
 *
 * `audited` and `evidence` are null when no audit data exists at all, which
 * keeps "unknown" apart from "audited and found nothing".
 */
export function buildCriteriaMeta(
  scenario: Scenario | undefined,
  rulesBroken: string[],
  auditedIds?: Set<string> | null,
  evidence?: Record<string, string> | null,
): CriteriaMeta[] {
  const broken = new Set(rulesBroken);
  return (scenario?.criteria ?? []).map((criterion, i) => {
    const id = criterionIdFor(i);
    return {
      id,
      description: criterion.description,
      type: criterion.type,
      passed: !broken.has(id),
      audited: auditedIds ? auditedIds.has(id) : null,
      evidence: evidence ? (evidence[id] ?? "") : null,
    };
  });
}
