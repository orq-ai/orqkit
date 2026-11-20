import { esc } from "../common/reports/html-helpers.js";
import type {
  FacetCatalogue,
  FacetSelection,
  NumericFilters,
} from "../trace-finder/models.js";
import { NUMERIC_FACET_NAMES } from "../trace-finder/models.js";

export const FACET_LABELS = [
  ["project", "project"],
  ["agent_name", "agent"],
  ["model", "model"],
  ["provider", "provider"],
  ["status", "status"],
  ["product", "product"],
  ["trace_type", "trace type"],
  ["tool_name", "tool"],
  ["tokens", "total tokens"],
  ["duration_ms", "duration"],
] as const;

export const camel = (name: string) =>
  name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

const isNumeric = (name: string) =>
  (NUMERIC_FACET_NAMES as readonly string[]).includes(name);

const grouped = (value: number) => value.toLocaleString("en-US");

export function selectedValues(
  selection: FacetSelection | null | undefined,
  name: string,
): ReadonlySet<string> {
  if (!selection) return new Set();
  return (
    (selection as unknown as Record<string, ReadonlySet<string> | undefined>)[
      camel(name)
    ] ?? new Set()
  );
}

function numericBound(
  numeric: NumericFilters | null | undefined,
  name: string,
): number | null {
  if (!numeric) return null;
  return (
    (numeric as unknown as Record<string, number | null>)[camel(name)] ?? null
  );
}

export function windowCountNote(windowDays: number | null): string {
  if (windowDays === null) return "Traces in the selected time window";
  return `Traces in the last ${grouped(windowDays)} day${windowDays === 1 ? "" : "s"}`;
}

function facetValues(
  catalogue: FacetCatalogue | null | undefined,
  name: string,
): string[] {
  if (!catalogue || isNumeric(name)) return [];
  return [
    ...((catalogue as unknown as Record<string, Iterable<string> | undefined>)[
      camel(name)
    ] ?? []),
  ];
}

const fold = (value: string) => value.toLowerCase();

export function countedValues(
  values: readonly string[],
  counts: Record<string, number>,
  truncated = false,
): [string[], Map<string, number | null>] {
  const folded = new Map<string, number>();
  for (const [key, count] of Object.entries(counts))
    folded.set(fold(key), (folded.get(fold(key)) ?? 0) + count);
  const known = new Set(values.map(fold));
  const all = [
    ...values,
    ...Object.keys(counts).filter((key) => !known.has(fold(key))),
  ];
  const missing = truncated ? null : 0;
  const resolved = new Map<string, number | null>();
  for (const value of all)
    resolved.set(
      value,
      Object.hasOwn(counts, value)
        ? (counts[value] as number)
        : (folded.get(fold(value)) ?? missing),
    );
  const ordered = all
    .map((value, index) => ({ value, index }))
    .sort(
      (a, b) =>
        -(resolved.get(a.value) ?? 0) + (resolved.get(b.value) ?? 0) ||
        a.index - b.index,
    )
    .map(({ value }) => value);
  return [ordered, resolved];
}

const pySorted = (values: Iterable<string>) =>
  [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

export interface FacetMenuOptions {
  formId: string;
  selection?: FacetSelection | null;
  numeric?: NumericFilters | null;
  includeNumeric?: boolean;
  counts?: Record<string, Record<string, number>> | null;
  countNote?: string;
  countTitle?: string;
  listNoteHtml?: string;
  containerAttrs?: string;
  open?: boolean;
}

export function renderFacetMenu(
  catalogue: FacetCatalogue | null | undefined,
  options: FacetMenuOptions,
): string {
  const {
    formId,
    selection,
    numeric,
    includeNumeric = true,
    counts,
    countNote = "",
    countTitle = "",
    listNoteHtml = "",
    containerAttrs = "",
    open = false,
  } = options;
  const title = countTitle || countNote;
  const titleAttr = title ? ` title="${esc(title)}"` : "";
  const truncatedFacets = catalogue?.truncatedFacets as
    | ReadonlySet<string>
    | undefined;
  const items: string[] = [];
  const subs: string[] = [];
  for (const [name, label] of FACET_LABELS) {
    const numericFacet = isNumeric(name);
    if (numericFacet && !includeNumeric) continue;
    const selected = selectedValues(selection, name);
    let values = [
      ...new Set([...facetValues(catalogue, name), ...pySorted(selected)]),
    ];
    let count: number;
    let body: string;
    if (numericFacet) {
      const minimum = numericBound(numeric, `${name}_min`);
      const maximum = numericBound(numeric, `${name}_max`);
      count = [minimum, maximum].filter((bound) => bound !== null).length;
      body =
        `<label><span>≥</span><input form="${formId}" name="${esc(name)}_min" type="number" min="0" ` +
        `placeholder="min" value="${minimum !== null ? esc(String(minimum)) : ""}"></label>` +
        `<label><span>≤</span><input form="${formId}" name="${esc(name)}_max" type="number" min="0" ` +
        `placeholder="max" value="${maximum !== null ? esc(String(maximum)) : ""}"></label>`;
    } else {
      count = selected.size;
      const facetCounts = counts?.[name];
      let resolved: Map<string, number | null> | null = null;
      if (facetCounts !== undefined && facetCounts !== null) {
        const truncated = truncatedFacets?.has(name) ?? false;
        [values, resolved] = countedValues(values, facetCounts, truncated);
      }
      const optionsHtml = values
        .map((value) => {
          const n = resolved?.get(value);
          return (
            `<label><input form="${formId}" type="checkbox" name="facet_${esc(name)}" value="${esc(value)}"${selected.has(value) ? " checked" : ""}><span>${esc(value)}</span>` +
            (resolved !== null && n !== null && n !== undefined
              ? `<span class="facet-n"${titleAttr}>${grouped(n)}</span>`
              : "") +
            "</label>"
          );
        })
        .join("");
      if (optionsHtml) {
        const overflow = truncatedFacets?.has(name)
          ? '<p class="facet-note">More values exist in Orq; showing the returned values ranked by frequency.</p>'
          : "";
        const scope =
          resolved !== null && countNote
            ? `<p class="facet-scope">${esc(countNote)}</p>`
            : "";
        body =
          `${scope}<input class="facet-search" type="search" placeholder="Search values" aria-label="Search ${esc(label)} values" autocomplete="off">` +
          `<div class="facet-values">${optionsHtml}</div>` +
          '<p class="facet-no-results" hidden>No matching values in this list.</p>' +
          overflow;
      } else body = '<p class="finder-empty">No values in this window.</p>';
    }
    const countHtml = count ? `<span class="count">${count}</span>` : "";
    items.push(
      `<button type="button" class="facet-item" data-facet="${esc(name)}" aria-haspopup="true" ` +
        `aria-expanded="false"><span>${esc(label)}</span>${countHtml}<span class="chev" aria-hidden="true">&rsaquo;</span></button>`,
    );
    subs.push(
      `<div class="facet-sub" data-facet-sub="${esc(name)}" hidden><div class="hd">${esc(label)}</div>${body}</div>`,
    );
  }
  return (
    `<div class="finder-facets${open ? " open" : ""}"${containerAttrs}><div class="facet-list">${items.join("")}${listNoteHtml}</div>` +
    `${subs.join("")}</div>`
  );
}

export function renderFacetChips(
  selection: FacetSelection,
  numeric?: NumericFilters | null,
  options: { removable?: boolean; generated?: FacetSelection | null } = {},
): string {
  const { removable = false, generated } = options;
  const chip = (
    facet: string,
    label: string,
    valueHtml: string,
    removeName: string,
    removeValue: string | null,
    aria: string,
    ai = false,
  ) => {
    const aiClass = ai ? " ai" : "";
    const badge = ai ? '<b class="ai-badge">AI</b>' : "";
    if (!removable)
      return `<span class="chip${aiClass}"><b>${esc(label)}</b>${badge}<span class="v">${valueHtml}</span></span>`;
    const valueAttr =
      removeValue !== null ? ` data-finder-value="${esc(removeValue)}"` : "";
    return (
      `<span class="chip is-editable${aiClass}" data-chip-name="${esc(removeName)}"${valueAttr}>` +
      `<button type="button" class="chip-open" data-chip-open="${esc(facet)}" aria-label="Edit ${aria}">` +
      `<b>${esc(label)}</b>${badge}<span class="v">${valueHtml}</span></button>` +
      `<button type="button" class="finder-chip-remove" data-finder-remove="${esc(removeName)}"${valueAttr} ` +
      `aria-label="Remove ${aria}">✕</button></span>`
    );
  };
  const chips: string[] = [];
  for (const [name, label] of FACET_LABELS) {
    if (isNumeric(name)) continue;
    const generatedValues = selectedValues(generated, name);
    for (const value of pySorted(selectedValues(selection, name)))
      chips.push(
        chip(
          name,
          label,
          esc(value),
          `facet_${name}`,
          value,
          `${esc(label)} ${esc(value)}`,
          Boolean(generated) && generatedValues.has(value),
        ),
      );
  }
  for (const [name, label, operator] of [
    ["tokens_min", "total tokens", "≥"],
    ["tokens_max", "total tokens", "≤"],
    ["duration_ms_min", "duration", "≥"],
    ["duration_ms_max", "duration", "≤"],
  ] as const) {
    const value = numericBound(numeric, name);
    if (value === null) continue;
    const facet = name.slice(0, name.lastIndexOf("_"));
    const formatted = `${operator} ${grouped(value)}`;
    chips.push(
      chip(facet, label, formatted, name, null, `${label} ${formatted}`),
    );
  }
  return chips.join("");
}
