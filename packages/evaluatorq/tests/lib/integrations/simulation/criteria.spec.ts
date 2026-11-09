import { describe, expect, test } from "bun:test";

import {
  buildCriteriaMeta,
  buildCriteriaResults,
  CriteriaTracker,
} from "../../../../src/lib/integrations/simulation/criteria.js";
import type { Scenario } from "../../../../src/lib/integrations/simulation/types.js";

const scenario: Scenario = {
  name: "Refund",
  goal: "Get a refund",
  criteria: [
    { description: "offers a refund", type: "must_happen" },
    { description: "insults the user", type: "must_not_happen" },
  ],
};

const occurred = (id: string, evidence?: string) => ({
  criterion_id: id,
  occurred: true,
  evidence,
});
const notOccurred = (id: string) => ({ criterion_id: id, occurred: false });

describe("CriteriaTracker", () => {
  test("no criteria is verified and resolves to the fallback", () => {
    const tracker = new CriteriaTracker({ name: "s", goal: "g", criteria: [] });
    expect(tracker.verified).toBe(true);
    expect(tracker.resolve(["x"])).toEqual(["x"]);
  });

  test("criteria without an audit stay unverified", () => {
    const tracker = new CriteriaTracker(scenario);
    tracker.observe(null);
    tracker.observe([]);
    expect(tracker.verified).toBe(false);
    expect(tracker.resolve([])).toEqual([]);
  });

  test("a verdict for an unknown id does not verify the run", () => {
    const tracker = new CriteriaTracker(scenario);
    tracker.observe([occurred("criteria_9")]);
    expect(tracker.verified).toBe(false);
    expect(tracker.auditedIds.size).toBe(0);
  });

  test("an unmet must_happen is broken and a clean must_not_happen is not", () => {
    const tracker = new CriteriaTracker(scenario);
    tracker.observe([notOccurred("criteria_0"), notOccurred("criteria_1")]);
    expect(tracker.resolve([])).toEqual(["criteria_0"]);
  });

  test("a must_not_happen that occurred is broken", () => {
    const tracker = new CriteriaTracker(scenario);
    tracker.observe([occurred("criteria_0"), occurred("criteria_1")]);
    expect(tracker.resolve([])).toEqual(["criteria_1"]);
  });

  test("occurrence is sticky across later turns", () => {
    const tracker = new CriteriaTracker(scenario);
    tracker.observe([occurred("criteria_0", "first")]);
    tracker.observe([notOccurred("criteria_0")]);
    tracker.observe([occurred("criteria_0", "second")]);
    expect(tracker.brokenIds).toEqual([]);
    expect(tracker.settledIds).toEqual(new Set(["criteria_0"]));
    expect(tracker.evidence).toEqual({ criteria_0: "first" });
  });

  test("confirmedBrokenIds leaves out a must_happen that could still happen", () => {
    const tracker = new CriteriaTracker(scenario);
    tracker.observe([notOccurred("criteria_0"), occurred("criteria_1")]);
    expect(tracker.brokenIds).toEqual(["criteria_0", "criteria_1"]);
    expect(tracker.unconfirmedIds).toEqual(["criteria_0"]);
    expect(tracker.confirmedBrokenIds).toEqual(["criteria_1"]);
  });

  test("a partial audit reports the ids it never saw", () => {
    const tracker = new CriteriaTracker(scenario);
    tracker.observe([occurred("criteria_0")]);
    expect(tracker.verified).toBe(true);
    expect(tracker.unauditedIds).toEqual(["criteria_1"]);
  });
});

describe("buildCriteriaResults", () => {
  test("maps descriptions to whether they passed", () => {
    expect(buildCriteriaResults(scenario, ["criteria_1"])).toEqual({
      "offers a refund": true,
      "insults the user": false,
    });
  });

  test("a later pass cannot hide a failure under the same description", () => {
    const duplicated = {
      name: "Refund",
      goal: "Get a refund",
      criteria: [
        { description: "same words", type: "must_happen" as const },
        { description: "same words", type: "must_not_happen" as const },
      ],
    };

    expect(buildCriteriaResults(duplicated, ["criteria_0"])).toEqual({
      "same words": false,
    });
  });
});

describe("buildCriteriaMeta", () => {
  test("keeps unknown apart from audited", () => {
    const [unknown] = buildCriteriaMeta(scenario, [], null, null);
    expect(unknown?.audited).toBeNull();
    expect(unknown?.evidence).toBeNull();

    const [audited, unaudited] = buildCriteriaMeta(
      scenario,
      ["criteria_1"],
      new Set(["criteria_0"]),
      { criteria_0: "quote" },
    );
    expect(audited).toEqual({
      id: "criteria_0",
      description: "offers a refund",
      type: "must_happen",
      passed: true,
      audited: true,
      evidence: "quote",
    });
    expect(unaudited?.passed).toBe(false);
    expect(unaudited?.audited).toBe(false);
    expect(unaudited?.evidence).toBe("");
  });
});
