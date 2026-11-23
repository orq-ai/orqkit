import { expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  coerceSimulationPageSize,
  renderSimulationRowList,
} from "../../../src/lib/dashboard/sim-views.js";
import type { SimulationDashboardEntry } from "../../../src/lib/dashboard/simulation-entities.js";
import goldens from "../fixtures/simulation-row-list-python-goldens.json" with {
  type: "json",
};

const hash = (html: string) => createHash("sha256").update(html).digest("hex");
for (const [index, row] of goldens.cases.entries())
  test(`Python conversation row list ${index}`, async () => {
    const entries = goldens.sets[row.set]
        ?.entries as unknown as SimulationDashboardEntry[],
      o = row.options;
    expect(
      hash(
        await renderSimulationRowList('r<&"', entries, {
          sort: o.sort,
          direction: o.direction,
          page: o.page,
          pageSize: o.page_size,
        }),
      ),
    ).toBe(row.expected);
  });
for (const [index, row] of goldens.sizes.entries())
  test(`Python row page size ${index}`, () =>
    expect(coerceSimulationPageSize(row.input)).toBe(row.expected));
