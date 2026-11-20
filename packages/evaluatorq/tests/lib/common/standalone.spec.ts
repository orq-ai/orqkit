import { expect, it } from "bun:test";
import { createHash } from "node:crypto";

import {
  expandedSections,
  expandReportDetails,
  type StandaloneItem,
  standaloneDocument,
} from "../../../src/lib/common/reports/standalone.js";
import goldens from "../fixtures/standalone-python-goldens.json" with {
  type: "json",
};

for (const [index, row] of goldens.expanded.entries())
  it(`matches pinned disclosure expansion ${index}`, () =>
    expect(expandReportDetails(row.input)).toBe(row.expected));
for (const [index, row] of goldens.sections.entries())
  it(`matches pinned standalone section navigation ${index}`, () =>
    expect(
      expandedSections(row.group, row.items as unknown as StandaloneItem[], {
        brief: row.brief,
      }),
    ).toBe(row.expected));
for (const [index, row] of goldens.documents.entries())
  it(`matches complete pinned standalone document ${index}`, () => {
    const html = standaloneDocument('Title <&> "test"', row.body);
    expect(createHash("sha256").update(html).digest("hex")).toBe(
      row.expectedHash,
    );
    expect(Array.from(html).length).toBe(row.expectedCharacters);
    expect(html).toContain("data:font/woff2;base64,");
    expect(html).not.toMatch(/url\(["']?https?:/);
    expect(html).not.toMatch(/@import\s/);
  });
