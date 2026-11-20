import { expect, test } from "bun:test";

import {
  RunFormValues,
  renderRunForm,
} from "../../../src/lib/dashboard/insights-run-form.js";

test("defaults tick the first preset and render three steps", async () => {
  const values = await RunFormValues.defaults();
  expect(values.preset).toBe("failures");
  expect([...values.dimensions]).toEqual(["failure", "intent"]);
  const html = renderRunForm(values, { csrf: "tok" });
  expect(html).toContain('name="csrf" value="tok"');
  expect(html).toContain('data-step="3"');
  expect(html).toContain('value="made_errors" checked');
});

test("from form drops fields of the unchosen tab and reads facets", async () => {
  const form = new URLSearchParams([
    ["source", "orq"],
    ["query", " refunds "],
    ["facet_agent_name", "bot"],
    ["trace_file", "/x.json"],
    ["dimensions", "intent"],
    ["trace_input_chars", "1000"],
  ]);
  const values = await RunFormValues.fromForm(form);
  expect(values.source).toBe("query");
  expect(values.query).toBe("refunds");
  expect(values.traceFile).toBe("");
  const fields = values.launchFields();
  expect((fields.facets as Record<string, string[]>).agent_name).toEqual([
    "bot",
  ]);
  expect(fields.trace_input_chars).toBe(1000);
});

test("bad numbers, JSON and tabs are rejected", async () => {
  await expect(
    RunFormValues.fromForm({ source: "orq", limit: "x" }),
  ).rejects.toThrow("Trace limit must be a whole number.");
  await expect(
    RunFormValues.fromForm({ source: "orq", custom_labels_json: "{" }),
  ).rejects.toThrow("valid JSON");
  await expect(RunFormValues.fromForm({ source: "nope" })).rejects.toThrow(
    "Choose Orq traces",
  );
});
