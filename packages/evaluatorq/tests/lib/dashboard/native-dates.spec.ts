import { expect, test } from "bun:test";

import { dateInput, dateRow } from "../../../src/lib/dashboard/native-dates.js";

test("date input matches the Python fasthtml output", () => {
  expect(
    dateInput({
      controlId: "x",
      name: "from",
      label: "From date",
      cssClass: "xr-date",
      required: true,
      preserve: true,
      form: "f",
      utc: "2026-01-01T00:00:00",
      value: "2026-01-01",
    }),
  ).toBe(
    '<input name="from" type="date" value="2026-01-01" aria-label="From date" required form="f" hx-preserve data-utc="2026-01-01T00:00:00" id="x" class="xr-date">\n',
  );
  expect(
    dateInput({
      controlId: 'a"&<',
      name: "n",
      label: 'L"<>&',
      value: "v&",
      utc: "u",
    }),
  ).toBe(
    '<input name="n" type="date" value="v&amp;" aria-label=\'L"&lt;&gt;&amp;\' data-utc="u" id=\'a"&amp;&lt;\'>\n',
  );
});

test("date row matches the Python fasthtml output", () => {
  expect(dateRow("A&<", "x", { cssClass: 'c"' })).toBe(
    "<span class='c\"'><b>A&amp;&lt;</b>x</span>",
  );
  expect(dateRow("A&<", "x", { cssClass: "c", labelTag: "label" })).toBe(
    '<label class="c">A&amp;&lt;x</label>',
  );
});
