import { MESSAGE_KINDS } from "../insights/conversation-view.js";
import {
  type CompressionKnobs,
  type FormValues,
  JEV_EDGE_FIELDS,
  JEV_FLAGS,
  JEV_FORMAT_FLAGS,
  MAX_KNOB_CHARS,
  READABLE_STYLE_FLAGS,
  VIEW_CAP_FIELDS,
} from "./compression-inspector-data.js";
import { csrfField } from "./security.js";

export const PREVIEW_ROUTE = "/compression-inspector/preview";
const RESET_SCRIPT =
  "var f=this.form;" +
  "f.querySelectorAll('[data-default]').forEach(function(e){" +
  "if(e.type==='checkbox'){e.checked=e.dataset.default==='1';}else{e.value=e.dataset.default;}});" +
  "document.getElementById('compression-output').classList.toggle('is-wrapped',f.elements.wrap.checked);" +
  "f.dispatchEvent(new Event('change',{bubbles:true}));";
const WRAP_SCRIPT =
  "document.getElementById('compression-output').classList.toggle('is-wrapped',this.checked)";

const JEV_EDGE_LABELS: Record<string, string> = {
  assistant: "Assistant messages",
  user: "User messages",
  system: "System and developer messages",
  tool_input: "Tool call input",
  tool_result: "Tool results",
};
const JEV_FLAG_LABELS: Record<string, string> = {
  system: "System",
  developer: "Developer",
  user: "User",
  assistant: "Assistant",
  tool_calls: "Tool calls",
  tool_results: "Tool results",
};
const VIEW_KIND_LABELS: Record<string, string> = {
  system: "System",
  user: "User",
  assistant: "Assistant",
  reasoning: "Reasoning",
  tool_input: "Tool inputs",
  tool_result: "Tool results",
};
const VIEW_CAP_LABELS: Record<string, string> = {
  view_system_chars: "System message limit",
  view_user_chars: "User message limit",
  view_assistant_edge: "Assistant edge kept",
  view_reasoning_chars: "Reasoning limit",
  view_tool_input_chars: "Tool input limit",
  view_tool_max_chars: "Tool result limit",
};
const JEV_FORMAT_LABELS: Record<string, string> = {
  located_omission: "Mark omitted messages at each source gap",
  field_order: "Identifiers and status before text",
  drop_empty: "Leave out empty fields",
};
const READABLE_STYLE_LABELS: Record<string, string> = {
  blocks: "Message blocks with source indexes",
  pair_results: "Pair tool results with calls (requires message blocks)",
  plain_tool_input: "Show tool input as plain text",
  labelled_cuts: "Label cuts with the part and exact omitted count",
  strip_terminal_noise: "Remove terminal control codes and progress redraws",
  shorten_cwd: "Shorten the session working directory to &lt;cwd&gt;",
  collapse_repeats: "Collapse consecutive repeated tool output",
  collapse_blobs: "Collapse long hex and base64 blobs",
};
const ORIGINAL_OPTIONS = [
  ["atif", "ATIF trajectory (canonical)"],
  ["source", "Raw source file (local sessions)"],
  ["readable", "Readable text"],
] as const;
const TOOLS_OPTIONS = [
  ["per_call", "One line per call"],
  ["collapsed", "Collapsed, no results"],
] as const;

export const grouped = (value: number) => value.toLocaleString("en-US");
const shown = (value: unknown) =>
  value === -1
    ? "whole (-1)"
    : typeof value === "number"
      ? grouped(value)
      : String(value);
const flag = (value: unknown) => (value ? 1 : 0);

function numberField(
  name: string,
  label: string,
  values: FormValues,
  defaults: FormValues,
  low = 1,
): string {
  return (
    '<label class="compression-knob">' +
    `<span>${label}</span>` +
    `<input type="number" name="${name}" value="${values[name]}" min="${low}" max="${MAX_KNOB_CHARS}" ` +
    `step="1" required data-default="${defaults[name]}">` +
    `<small>Default ${shown(defaults[name])}</small></label>`
  );
}

function check(
  name: string,
  label: string,
  values: FormValues,
  defaults: FormValues,
): string {
  const checked = values[name] ? " checked" : "";
  return (
    '<label class="compression-check">' +
    `<input type="checkbox" name="${name}" value="1"${checked} data-default="${flag(defaults[name])}">` +
    `<span>${label}</span></label>`
  );
}

function displayGroup(
  values: FormValues,
  defaults: FormValues,
  hasSource: boolean,
): string {
  const options = ORIGINAL_OPTIONS.filter(
    ([value]) => value !== "source" || hasSource,
  )
    .map(
      ([value, label]) =>
        `<option value="${value}"${values.original_view === value ? " selected" : ""}>${label}</option>`,
    )
    .join("");
  const wrap =
    '<label class="compression-check">' +
    `<input type="checkbox" name="wrap" value="1"${values.wrap ? " checked" : ""} ` +
    `data-default="${flag(defaults.wrap)}" onchange="${WRAP_SCRIPT}">` +
    "<span>Wrap long lines</span></label>";
  const coverage = check(
    "coverage",
    "Describe what is present and absent at the start",
    values,
    defaults,
  );
  return (
    '<div class="compression-knob-grid compression-display">' +
    '<label class="compression-knob"><span>Original shows</span>' +
    `<select name="original_view" data-default="${defaults.original_view}">${options}</select>` +
    "<small>Default ATIF trajectory</small></label>" +
    `${wrap}${coverage}` +
    "</div>"
  );
}

function jevGroup(values: FormValues, defaults: FormValues): string {
  const limits = Object.entries(JEV_EDGE_FIELDS)
    .map(
      ([part, [total, edge]]) =>
        '<div class="compression-knob-pair">' +
        numberField(
          total,
          `${JEV_EDGE_LABELS[part]}, whole up to`,
          values,
          defaults,
        ) +
        numberField(
          edge,
          `${JEV_EDGE_LABELS[part]}, edge kept`,
          values,
          defaults,
        ) +
        "</div>",
    )
    .join("");
  const flags = JEV_FLAGS.map((name) =>
    check(
      `jev_include_${name}`,
      JEV_FLAG_LABELS[name] as string,
      values,
      defaults,
    ),
  ).join("");
  return (
    '<fieldset class="compression-knob-group">' +
    "<legend>Output (Jev state)</legend>" +
    '<div class="compression-knob-grid">' +
    numberField("global_char_cap", "Global character cap", values, defaults) +
    numberField("jev_state_chars", "Jev state limit", values, defaults) +
    "</div>" +
    `<div class="compression-knob-grid">${limits}</div>` +
    '<p class="compression-knob-title">Include</p>' +
    `<div class="compression-checks">${flags}</div>` +
    '<p class="compression-knob-title">Format</p>' +
    '<div class="compression-checks">' +
    JEV_FORMAT_FLAGS.map((name) =>
      check(`jev_${name}`, JEV_FORMAT_LABELS[name] as string, values, defaults),
    ).join("") +
    "</div>" +
    '<p class="compression-count-note">A text longer than its whole-up-to limit keeps that many characters at ' +
    "each edge, so an edge may be at most half of it. Turning off tool calls drops their results as well; " +
    "turning off tool results keeps the calls without them.</p>" +
    "</fieldset>"
  );
}

function viewGroup(values: FormValues, defaults: FormValues): string {
  const kinds = [...MESSAGE_KINDS]
    .sort()
    .map((kind) =>
      check(
        `view_include_${kind}`,
        VIEW_KIND_LABELS[kind] as string,
        values,
        defaults,
      ),
    )
    .join("");
  const caps = Object.keys(VIEW_CAP_FIELDS)
    .map((name) =>
      numberField(name, VIEW_CAP_LABELS[name] as string, values, defaults, -1),
    )
    .join("");
  const options = TOOLS_OPTIONS.map(
    ([value, label]) =>
      `<option value="${value}"${values.view_tools === value ? " selected" : ""}>${label}</option>`,
  ).join("");
  return (
    '<fieldset class="compression-knob-group">' +
    "<legend>Readable text</legend>" +
    '<div class="compression-knob-grid">' +
    numberField("view_budget", "Whole view limit", values, defaults) +
    '<label class="compression-knob"><span>Tool display</span>' +
    `<select name="view_tools" data-default="${defaults.view_tools}">${options}</select>` +
    "<small>Default one line per call</small></label>" +
    "</div>" +
    '<p class="compression-knob-title">Include</p>' +
    `<div class="compression-checks">${kinds}</div>` +
    `<div class="compression-knob-grid">${caps}</div>` +
    '<p class="compression-knob-title">Layout and de-noising</p>' +
    '<div class="compression-checks">' +
    READABLE_STYLE_FLAGS.map((name) =>
      check(
        `view_${name}`,
        READABLE_STYLE_LABELS[name] as string,
        values,
        defaults,
      ),
    ).join("") +
    "</div>" +
    '<p class="compression-count-note">These options apply when Original shows Readable text. Use -1 to keep a part whole. A tool result limit of 0 leaves results out.</p>' +
    "</fieldset>"
  );
}

export function knobsFormHtml(
  knobs: CompressionKnobs,
  defaults: CompressionKnobs,
  token: string,
  options: { hasSource: boolean },
): string {
  const values = knobs.asForm(),
    defaultValues = defaults.asForm();
  return (
    '<form class="compression-knobs" autocomplete="off" novalidate ' +
    `hx-post="${PREVIEW_ROUTE}" hx-trigger="change, input delay:400ms" hx-target="#compression-output" ` +
    'hx-swap="outerHTML" hx-sync="this:replace">' +
    `${csrfField()}<input type="hidden" name="token" value="${token}">` +
    displayGroup(values, defaultValues, options.hasSource) +
    '<div class="compression-knobs-groups">' +
    viewGroup(values, defaultValues) +
    jevGroup(values, defaultValues) +
    "</div>" +
    '<div class="compression-knobs-footer">' +
    `<button type="button" class="compression-reset" onclick="${RESET_SCRIPT}">Reset to defaults</button>` +
    '<p class="compression-count-note">The Original is the canonical ATIF JSON, the raw session file or the readable ' +
    "text, which uses the Insights full_conversation_view options. The Output uses the classifier Jev limits. " +
    "Every original is scrubbed of known secrets and cut to 2,000,000 characters, and a raw session file is read " +
    "up to 5,000,000 bytes; a note says when anything is cut. Coverage is added to the readable " +
    "text and Jev state, not ATIF or raw-source originals. Format switches start on here only; production " +
    "Insights and classifier defaults are unchanged. Changes update the preview as you make them.</p>" +
    "</div></form>"
  );
}
