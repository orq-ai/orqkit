import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";

import * as catalogue from "../../../src/lib/redteam/index.js";
import fixtures from "../fixtures/redteam-catalogue-python-goldens.json" with {
  type: "json",
};

let warn: ReturnType<typeof spyOn<typeof console, "warn">>;
beforeEach(() => {
  catalogue.clearCustomDeliveryMethods();
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  catalogue.clearCustomDeliveryMethods();
  warn.mockRestore();
});
it("matches every pinned vulnerability definition and framework index", () => {
  expect(catalogue.VULNERABILITY_DEFS as unknown).toEqual(fixtures.definitions);
  expect(catalogue.CATEGORY_TO_VULNERABILITY as unknown).toEqual(
    fixtures.categories,
  );
  expect(catalogue.FRAMEWORK_TO_VULNERABILITIES as unknown).toEqual(
    fixtures.frameworks,
  );
  expect(catalogue.DELIVERY_METHOD_CATEGORY as unknown).toEqual(
    fixtures.deliveryCategories,
  );
  expect(catalogue.listAvailableVulnerabilities()).toEqual(
    Object.keys(fixtures.definitions) as catalogue.Vulnerability[],
  );
  for (const definition of Object.values(catalogue.VULNERABILITY_DEFS)) {
    expect(catalogue.VulnerabilityDefSchema.parse(definition)).toEqual(
      definition,
    );
    expect(catalogue.getVulnerabilityName(definition.id)).toBe(definition.name);
    expect(catalogue.getFrameworkCategories(definition.id)).toEqual(
      definition.frameworkMappings,
    );
    expect(catalogue.getPrimaryCategory(definition.id)).toBe(
      Object.values(definition.frameworkMappings).find(
        (codes) => codes.length,
      )?.[0] ?? definition.id,
    );
  }
  expect(catalogue.getVulnerabilityDef("unknown")).toBeNull();
  expect(catalogue.getVulnerabilityName("unknown")).toBe("unknown");
  expect(catalogue.getFrameworkCategories("unknown")).toEqual({});
  expect(catalogue.getPrimaryCategory("unknown")).toBe("unknown");
});
for (const entry of fixtures.categoryCases)
  it(`matches category resolution for ${JSON.stringify(entry.value)}`, () => {
    expect(catalogue.resolveCategorySafe(entry.value)).toBe(
      entry.expected as catalogue.Vulnerability | null,
    );
    if (entry.error)
      expect(() => catalogue.resolveCategory(entry.value)).toThrow(RangeError);
    else
      expect(catalogue.resolveCategory(entry.value)).toBe(
        entry.expected as catalogue.Vulnerability,
      );
  });
for (const [index, entry] of fixtures.resolutions.entries())
  it(`matches vulnerability resolution case ${index}`, () => {
    if (entry.error)
      expect(() => catalogue.resolveVulnerabilities(entry.values)).toThrow(
        RangeError,
      );
    else
      expect(catalogue.resolveVulnerabilities(entry.values) as unknown).toEqual(
        entry.expected,
      );
  });
for (const entry of fixtures.registrations)
  it(`matches registration lifecycle for ${JSON.stringify(entry.value)}`, () => {
    expect(catalogue.isKnownDeliveryMethod(entry.value)).toBe(
      entry.knownBefore,
    );
    if (entry.error)
      expect(() =>
        catalogue.registerDeliveryMethod(entry.value, {
          category: "test-family",
        }),
      ).toThrow(RangeError);
    else
      expect(
        catalogue.registerDeliveryMethod(entry.value, {
          category: "test-family",
        }),
      ).toBe(entry.registered as string);
    expect(catalogue.isKnownDeliveryMethod(entry.value)).toBe(entry.knownAfter);
    expect(catalogue.listAvailableDeliveryMethods()).toEqual(entry.available);
  });
it("matches pinned enum values and exact open-set delivery resolution", () => {
  const knownEnums = {
    AttackTechnique: catalogue.AttackTechnique,
    DeliveryMethod: catalogue.DeliveryMethod,
    Severity: catalogue.Severity,
    Framework: catalogue.Framework,
    VulnerabilityDomain: catalogue.VulnerabilityDomain,
    Vulnerability: catalogue.Vulnerability,
  };
  for (const name of [
    "AttackTechnique",
    "DeliveryMethod",
    "Severity",
    "Framework",
    "VulnerabilityDomain",
    "Vulnerability",
  ] as const)
    expect(knownEnums[name] as unknown).toEqual(fixtures.enums[name]);
  for (const entry of fixtures.methods)
    expect(catalogue.resolveDeliveryMethods(entry.values)).toEqual(
      entry.expected,
    );
  expect(catalogue.isKnownAttackTechnique("indirect-injection")).toBe(true);
  expect(catalogue.isKnownAttackTechnique("INDIRECT_INJECTION")).toBe(false);
  expect(catalogue.resolveDeliveryMethod("unknown")).toBe("unknown");
  expect(catalogue.isKnownDeliveryMethod("unknown")).toBe(false);
});
it("keeps registrations process-wide, preserves insertion order on re-registration and clears them", () => {
  catalogue.registerDeliveryMethod("custom-a");
  catalogue.registerDeliveryMethod("custom-b");
  catalogue.registerDeliveryMethod("custom-a", { category: "changed" });
  expect(catalogue.listAvailableDeliveryMethods().slice(-2)).toEqual([
    "custom-a",
    "custom-b",
  ]);
  expect(
    catalogue.resolveDeliveryMethods(["custom-b", "custom-a", "custom-b"]),
  ).toEqual(["custom-b", "custom-a"]);
  catalogue.clearCustomDeliveryMethods();
  expect(catalogue.isKnownDeliveryMethod("custom-a")).toBe(false);
});
it("prevents mutation of canonical lookup tables", () => {
  expect(Object.isFrozen(catalogue.VULNERABILITY_DEFS)).toBe(true);
  expect(Object.isFrozen(catalogue.CATEGORY_TO_VULNERABILITY)).toBe(true);
  expect(Object.isFrozen(catalogue.FRAMEWORK_TO_VULNERABILITIES)).toBe(true);
  expect(Object.isFrozen(catalogue.DELIVERY_METHOD_CATEGORY)).toBe(true);
});
