import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  renderFacetChips,
  renderFacetMenu,
  windowCountNote,
} from "../../../src/lib/dashboard/facet-picker.js";
import {
  FacetCatalogueSchema,
  FacetSelection,
  NumericFilters,
} from "../../../src/lib/trace-finder/models.js";

type Json = Record<string, unknown>;
const goldens = JSON.parse(
  readFileSync(
    new URL("../fixtures/facet-picker-python-goldens.json", import.meta.url),
    "utf8",
  ),
) as {
  menus: { catalogue: Json | null; kw: Json; html: string }[];
  chips: {
    selection: Json;
    numeric: Json | null;
    removable: boolean;
    generated: Json | null;
    html: string;
  }[];
  notes: string[];
};

for (const [i, c] of goldens.menus.entries())
  test(`facet menu matches Python: case ${i}`, () => {
    const kw = c.kw;
    const html = renderFacetMenu(
      c.catalogue ? FacetCatalogueSchema.parse(c.catalogue) : null,
      {
        formId: kw.form_id as string,
        selection: kw.selection ? new FacetSelection(kw.selection) : null,
        numeric: kw.numeric ? new NumericFilters(kw.numeric) : null,
        includeNumeric: (kw.include_numeric as boolean | undefined) ?? true,
        counts: (kw.counts as Record<string, Record<string, number>>) ?? null,
        countNote: kw.count_note as string | undefined,
        countTitle: kw.count_title as string | undefined,
        listNoteHtml: kw.list_note_html as string | undefined,
        containerAttrs: kw.container_attrs as string | undefined,
        open: kw.open_ as boolean | undefined,
      },
    );
    expect(html).toBe(c.html);
  });

for (const [i, c] of goldens.chips.entries())
  test(`facet chips match Python: case ${i}`, () => {
    expect(
      renderFacetChips(
        new FacetSelection(c.selection),
        c.numeric ? new NumericFilters(c.numeric) : null,
        {
          removable: c.removable,
          generated: c.generated ? new FacetSelection(c.generated) : null,
        },
      ),
    ).toBe(c.html);
  });

test("window count note matches Python", () => {
  expect([null, 1, 7, 1500].map(windowCountNote)).toEqual(goldens.notes);
});
