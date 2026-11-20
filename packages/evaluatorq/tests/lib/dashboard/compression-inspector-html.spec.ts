import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TraceDocument } from "../../../src/lib/common/trace-document.js";
import { outputHtml } from "../../../src/lib/dashboard/compression-inspector.js";
import {
  CompressionKnobs,
  previewDocument,
} from "../../../src/lib/dashboard/compression-inspector-data.js";
import { knobsFormHtml } from "../../../src/lib/dashboard/compression-inspector-knobs.js";
import { csrfField } from "../../../src/lib/dashboard/security.js";

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"),
  );

const previews = fixture("compression-preview-python-goldens.json") as {
  name: string;
  document_json: string;
  source: string | null;
  form: Record<string, string>;
}[];
const html = fixture("compression-inspector-html-python-goldens.json") as {
  cases: { name: string; form_html: string; output_html: string }[];
  notice: string;
};
const scratch = mkdtempSync(join(tmpdir(), "compression-html-"));
const defaults = CompressionKnobs.defaults(10_000);

for (const [i, c] of html.cases.entries())
  test(`knobs form and output match Python: ${c.name}`, async () => {
    const input = previews[i];
    expect(input?.name).toBe(c.name);
    if (!input) return;
    let sourcePath: string | null = null;
    if (input.source !== null) {
      sourcePath = join(scratch, `source-${i}.jsonl`);
      writeFileSync(sourcePath, input.source, "utf8");
    }
    const knobs = CompressionKnobs.fromForm(input.form);
    const form = knobsFormHtml(knobs, defaults, "TOKEN", {
      hasSource: sourcePath !== null,
    });
    expect(form.replace(csrfField(), "<CSRF>")).toBe(c.form_html);
    const preview = await previewDocument(
      new TraceDocument(JSON.parse(input.document_json)),
      { knobs, sourcePath },
    );
    expect(outputHtml({ preview, wrapped: knobs.wrap })).toBe(c.output_html);
  });

test("notice output escapes the message and keeps the wrap class", () => {
  expect(outputHtml({ notice: 'Bad <value> & "quote"', wrapped: true })).toBe(
    html.notice,
  );
});
