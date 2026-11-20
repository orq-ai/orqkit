import { expect, it } from "bun:test";

import { AgentContextSchema } from "../../../src/lib/contracts.js";
import {
  AgentCapabilities,
  type AttackTechnique,
  CATEGORY_TO_VULNERABILITY,
  filterStrategiesByMethod,
  getCategoryInfo,
  getStrategiesForCategory,
  getStrategiesForVulnerability,
  knownStrategyNames,
  listAvailableCategories,
  STRATEGY_REGISTRY,
  selectApplicableStrategies,
  selectApplicableStrategiesForVulnerability,
  VulnerabilitySchema,
} from "../../../src/lib/redteam/index.js";
import goldens from "../fixtures/strategy-python-goldens.json" with {
  type: "json",
};

function contextOf(raw: Record<string, unknown>) {
  return AgentContextSchema.parse({
    ...raw,
    key: "fixture",
    memoryStores: raw.memory_stores,
    knowledgeBases: raw.knowledge_bases,
  });
}
it("exports every pinned template, category summary and exact prefix alias", () => {
  expect(listAvailableCategories()).toEqual(goldens.categories);
  const info = Object.fromEntries(
    Object.entries(goldens.info).map(([category, value]) => [
      category,
      {
        name: value.name,
        strategyCount: value.strategy_count,
        singleTurnCount: value.single_turn_count,
        multiTurnCount: value.multi_turn_count,
        vulnerability:
          value.vulnerability === null
            ? null
            : VulnerabilitySchema.parse(value.vulnerability),
        vulnerabilityName: value.vulnerability_name,
      },
    ]),
  );
  expect(getCategoryInfo()).toEqual(info);
  expect(knownStrategyNames().size).toBe(goldens.templateCount);
  expect(STRATEGY_REGISTRY["OWASP-ASI01"]).toBe(STRATEGY_REGISTRY.ASI01);
  expect(getStrategiesForCategory("asi01")).toEqual([]);
  expect(getStrategiesForCategory("OWASP-OWASP-ASI01")).toEqual([]);
  for (const category of goldens.categories) {
    const vulnerability = CATEGORY_TO_VULNERABILITY[category];
    if (vulnerability)
      expect(getStrategiesForVulnerability(vulnerability)).toEqual(
        getStrategiesForCategory(category),
      );
  }
});
for (const fixture of goldens.cases)
  it(`matches pinned applicability context ${fixture.contextIndex} capability ${fixture.capabilitiesIndex}`, () => {
    const raw = goldens.contexts[fixture.contextIndex];
    if (!raw) throw new Error("Missing context");
    const context = contextOf(raw);
    const caps = goldens.capabilities[fixture.capabilitiesIndex];
    const capabilities = caps == null ? null : new AgentCapabilities(caps);
    for (const [category, names] of Object.entries(fixture.expected)) {
      expect(
        selectApplicableStrategies(category, context, capabilities).map(
          (strategy) => strategy.name,
        ),
      ).toEqual(names);
      const vulnerability = CATEGORY_TO_VULNERABILITY[category];
      if (vulnerability)
        expect(
          selectApplicableStrategiesForVulnerability(
            vulnerability,
            context,
            capabilities,
          ).map((strategy) => strategy.name),
        ).toEqual(names);
    }
  });
for (const [index, fixture] of goldens.filters.entries())
  it(`matches pinned user strategy filter ${index}`, () => {
    const all = Object.entries(STRATEGY_REGISTRY)
      .filter(([category]) => !category.startsWith("OWASP-"))
      .flatMap(([, values]) => values);
    const params = fixture.value;
    expect(
      filterStrategiesByMethod(all, {
        names: params.names === null ? null : new Set(params.names),
        deliveryMethods:
          params.delivery_methods === null
            ? null
            : new Set(params.delivery_methods),
        attackTechniques:
          params.attack_techniques === null
            ? null
            : new Set(params.attack_techniques as AttackTechnique[]),
      }).map((strategy) => strategy.name),
    ).toEqual(fixture.expected);
  });
it("keeps capabilities as a set for matching while retaining serialized list order", () => {
  const caps = new AgentCapabilities({
    capabilities: {
      first: ["memory_read", "memory_read"],
      second: ["database"],
    },
    classification_failed: true,
  });
  expect([...caps.allCapabilities()]).toEqual(["memory_read", "database"]);
  expect(caps.hasAny(["email", "database"])).toBe(true);
  expect(caps.hasAny([])).toBe(false);
  expect(caps.classificationFailed).toBe(true);
});
