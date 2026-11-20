import { expect, it } from "bun:test";

import { roleModel } from "../../../src/lib/common/model-roles.js";
import {
  getEvaluatorForCategory,
  getEvaluatorForVulnerability,
  getEvaluatorMetadataForCategory,
  getEvaluatorMetadataForVulnerability,
  LlmEvaluatorEntity,
  listAvailableEvaluatorCategories,
  OWASP_EVALUATOR_REGISTRY,
  OWASP_EVALUATOR_REGISTRY_FULL,
  VulnerabilitySchema,
} from "../../../src/lib/redteam/index.js";
import goldens from "../fixtures/owasp-python-goldens.json" with {
  type: "json",
};

for (const [category, entity] of Object.entries(goldens.entities))
  it(`matches pinned OWASP entity and prompt ${category}`, () => {
    const actual = getEvaluatorForCategory(category, "fixture-model");
    expect(actual?.toJSON()).toEqual(entity);
    expect(actual?.modelId).toBe("fixture-model");
    expect(
      getEvaluatorForCategory(`OWASP-${category}`, "fixture-model")?.toJSON(),
    ).toEqual(entity);
  });
it("preserves category order and all aliases without accepting unknown lookups", () => {
  expect(listAvailableEvaluatorCategories()).toEqual(goldens.categories);
  expect(Object.keys(OWASP_EVALUATOR_REGISTRY_FULL)).toEqual(
    Object.keys(OWASP_EVALUATOR_REGISTRY),
  );
  expect(getEvaluatorForCategory("LLM03")).toBeNull();
  expect(getEvaluatorForCategory("asi01")).toBeNull();
  expect(getEvaluatorForCategory("OWASP-OWASP-ASI01")).toBeNull();
  expect(getEvaluatorForCategory("constructor")).toBeNull();
});
for (const [vulnerability, category] of Object.entries(goldens.vulnerabilities))
  it(`resolves the pinned vulnerability evaluator ${vulnerability}`, () => {
    const actual = getEvaluatorForVulnerability(
      VulnerabilitySchema.parse(vulnerability),
      "fixture-model",
    );
    const expected = getEvaluatorForCategory(category, "fixture-model");
    if (!actual || !expected) throw new Error("Missing evaluator");
    expect(actual.toJSON()).toEqual(expected.toJSON());
  });
for (const [category, metadata] of Object.entries(goldens.metadata))
  it(`uses canonical or local metadata for ${category}`, () => {
    expect(getEvaluatorMetadataForCategory(category)).toEqual(
      metadata
        ? {
            evaluatorId: metadata.evaluator_id,
            evaluatorName: metadata.evaluator_name,
          }
        : null,
    );
  });
it("uses dynamic model defaults and creates independent model configs", () => {
  const first = getEvaluatorForCategory("ASI01"),
    second = getEvaluatorForCategory("ASI01");
  if (!first || !second) throw new Error("Missing factory");
  expect(first.modelId).toBe(roleModel("smart", { task: "redteam.evaluator" }));
  first.model.id = "changed";
  expect(second.modelId).not.toBe("changed");
  const decoded = new LlmEvaluatorEntity({
    model: { id: "echo", integration_id: "integration" },
    prompt: "Prompt",
    output_type: "boolean",
    guardrail_config: { under_score: { raw_key: true } },
    categorical_labels: [{ label_key: "raw" }],
  });
  expect(decoded.toJSON()).toMatchObject({
    model: { id: "echo", integrationId: "integration" },
    outputType: "boolean",
    guardrailConfig: { under_score: { raw_key: true } },
    categoricalLabels: [{ label_key: "raw" }],
  });
  expect(decoded.toJSON()).not.toHaveProperty("modelId");
  expect(getEvaluatorMetadataForVulnerability("supply_chain")).toEqual(
    getEvaluatorMetadataForCategory("LLM03"),
  );
});
