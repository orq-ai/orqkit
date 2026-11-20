import { describe, expect, it } from "bun:test";

import {
  pwSideColour,
  pwSideLabel,
  verdictEyebrow,
} from "../../../src/lib/dashboard/pairwise-palette.js";

const run = { labelA: "old", labelB: "new" };

describe("pairwise palette", () => {
  it("colours A, B and tie, and everything else as none", () => {
    expect(pwSideColour("A")).toBe("var(--pw-a)");
    expect(pwSideColour("B")).toBe("var(--pw-b)");
    expect(pwSideColour("tie")).toBe("var(--pw-tie)");
    expect(pwSideColour("inconclusive")).toBe("var(--pw-none)");
    expect(pwSideColour(null)).toBe("var(--pw-none)");
  });

  it("labels sides with the run labels and abstentions as abstain", () => {
    expect(pwSideLabel("A", run)).toBe("old");
    expect(pwSideLabel("B", run)).toBe("new");
    expect(pwSideLabel("tie", run)).toBe("tie");
    expect(pwSideLabel("inconclusive", run)).toBe("inconclusive");
    expect(pwSideLabel(null, run)).toBe("abstain");
  });

  it("words the verdict eyebrow per state", () => {
    expect(verdictEyebrow("clear")).toBe("✓ Clear winner");
    expect(verdictEyebrow("no_decided")).toBe("No decided comparisons");
    expect(verdictEyebrow("too_close")).toBe("⚠ Too close to call");
  });
});
