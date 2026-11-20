import { LOGO_SVG } from "./logo-svg.js";
import { pyFixed, pyG, pyPercent, pyRound } from "./number-format.js";
import { COLORS, type ColorScale } from "./palette.js";
import { REPORT_CSS } from "./report-css.js";
import {
  renderSvg,
  type VegaSpec,
  vlAvailable,
  vlBarH,
  vlDonut,
  vlHeatmap,
  vlHistogram,
  vlLine,
  vlSparkline,
} from "./vega.js";

export const STATUS_COLORS = {
  success: COLORS.success_400,
  warning: COLORS.yellow_400,
  failure: COLORS.red_400,
} as const;

export type CardStatus = "pass" | "fail" | "warn" | "neutral";

export interface KpiCard {
  label: string;
  value: string;
  status?: string;
  sub?: string;
}

const STATUSES = new Set(["pass", "fail", "warn", "neutral"]);

function safeStatus(status: string): string {
  return STATUSES.has(status) ? status : "neutral";
}

export function loadCss(): string {
  return REPORT_CSS;
}

export function esc(text: unknown): string {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
}

export function htmlTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  options: {
    rowAttrs?: readonly string[] | null;
    colClasses?: readonly string[] | null;
  } = {},
): string {
  const { rowAttrs, colClasses } = options;
  if (rowAttrs && rowAttrs.length !== rows.length) {
    throw new Error("row_attrs length must match rows");
  }
  if (colClasses && colClasses.length !== headers.length) {
    throw new Error("col_classes length must match headers");
  }
  const cls = (index: number): string =>
    colClasses?.[index] ? ` class="${esc(colClasses[index])}"` : "";

  const parts = ["<table>", "<thead><tr>"];
  headers.forEach((header, index) => {
    parts.push(`<th${cls(index)}>${esc(header)}</th>`);
  });
  parts.push("</tr></thead><tbody>");
  rows.forEach((row, rowIndex) => {
    const attrs = rowAttrs?.[rowIndex] ? ` ${rowAttrs[rowIndex]}` : "";
    parts.push(`<tr${attrs}>`);
    row.forEach((cell, index) => {
      parts.push(
        index < headers.length
          ? `<td${cls(index)} data-label="${esc(headers[index])}">${cell}</td>`
          : `<td>${cell}</td>`,
      );
    });
    parts.push("</tr>");
  });
  parts.push("</tbody></table>");
  return parts.join("");
}

export function statusBadge(text: string, status: string): string {
  return `<span class="status-badge status-badge--${safeStatus(status)}">${esc(text)}</span>`;
}

export function kpiCards(cards: readonly KpiCard[], modifier = ""): string {
  if (cards.length === 0) {
    return "";
  }
  const items = cards.map((card) => {
    const sub = card.sub ? `<div class="kpi-sub">${esc(card.sub)}</div>` : "";
    return (
      `<div class="kpi-card kpi-card--${safeStatus(card.status ?? "neutral")}">` +
      `<div class="kpi-value">${esc(card.value)}</div>` +
      `<div class="kpi-label">${esc(card.label)}</div>${sub}</div>`
    );
  });
  const bandClass = modifier
    ? `kpi-band kpi-band--${esc(modifier)}`
    : "kpi-band";
  return `<div class="${bandClass}">${items.join("")}</div>`;
}

export function loadLogoSvg(): string {
  return LOGO_SVG;
}

export function pct(rate: number | null | undefined): string {
  return rate === null || rate === undefined ? "n/a" : pyPercent(rate);
}

export function parseHttpUrl(url: string | null | undefined): URL | null {
  if (!url || !/^https?:\/\//i.test(url.trimStart())) {
    return null;
  }
  try {
    const parsed = new URL(url);
    return parsed.hostname ? parsed : null;
  } catch {
    return null;
  }
}

export function humanizeDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) {
    return "";
  }
  const total = Math.trunc(seconds);
  if (total < 60) {
    return `${total}s`;
  }
  return `${Math.floor(total / 60)}m ${total % 60}s`;
}

export function truncatePlain(text: string, maxChars = 800): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) {
    return text;
  }
  return `${chars.slice(0, maxChars).join("")}\n\n[truncated: full text in report JSON]`;
}

export function chartsAvailable(): Promise<boolean> {
  return vlAvailable();
}

async function chartCard(spec: VegaSpec, title: string): Promise<string> {
  const svg = await renderSvg(spec);
  return svg
    ? `<figure class="chart-card"><figcaption>${esc(title)}</figcaption>${svg}</figure>`
    : "";
}

export async function renderDonutChart(options: {
  labels: readonly string[];
  values: readonly number[];
  colors: readonly string[];
  title: string;
}): Promise<string> {
  const { labels, values, colors, title } = options;
  const count = Math.min(labels.length, values.length, colors.length);
  const kept = Array.from({ length: count }, (_, i) => i).filter(
    (i) => (values[i] as number) > 0,
  );
  if (kept.length === 0) {
    return "";
  }
  return chartCard(
    vlDonut({
      labels: kept.map((i) => labels[i] as string),
      values: kept.map((i) => values[i] as number),
      colors: kept.map((i) => colors[i] as string),
    }),
    title,
  );
}

export async function renderHorizontalBarChart(options: {
  labels: readonly string[];
  values: readonly number[];
  color: string;
  title: string;
  xTitle: string;
  valueSuffix?: string;
}): Promise<string> {
  const { labels, values, color, title, xTitle, valueSuffix = "" } = options;
  if (labels.length === 0) {
    return "";
  }
  return chartCard(
    vlBarH({
      labels,
      values,
      color,
      xTitle,
      valueLabels: values.map((v) => `${pyFixed(v, 0)}${valueSuffix}`),
    }),
    title,
  );
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace(/^#+/, "");
  return [
    Number.parseInt(h.slice(0, 2), 16),
    Number.parseInt(h.slice(2, 4), 16),
    Number.parseInt(h.slice(4, 6), 16),
  ];
}

function rgbToHex(rgb: readonly number[]): string {
  const channels = rgb.map((c) =>
    Math.max(0, Math.min(255, pyRound(c)))
      .toString(16)
      .padStart(2, "0"),
  );
  return `#${channels.join("")}`;
}

export function scaleColor(value: number, scale: ColorScale): string {
  const v = Math.max(0, Math.min(1, value));
  for (let i = 0; i < scale.length - 1; i++) {
    const [loPos, loColor] = scale[i] as readonly [number, string];
    const [hiPos, hiColor] = scale[i + 1] as readonly [number, string];
    if (loPos <= v && v <= hiPos) {
      const t = (v - loPos) / (hiPos - loPos || 1);
      const lo = hexToRgb(loColor);
      const hi = hexToRgb(hiColor);
      return rgbToHex(lo.map((c, k) => c + ((hi[k] as number) - c) * t));
    }
  }
  return (scale[scale.length - 1] as readonly [number, string])[1];
}

export async function svgDonut(options: {
  labels: readonly string[];
  values: readonly number[];
  colors: readonly string[];
  centerLabel: string;
  title: string;
}): Promise<string> {
  const { title, ...donut } = options;
  const total = donut.values.reduce((sum, v) => (v > 0 ? sum + v : sum), 0);
  if (total <= 0) {
    return "";
  }
  return chartCard(vlDonut(donut), title);
}

export async function svgBar(options: {
  rows: readonly (readonly [string, number])[];
  title: string;
  color?: string | null;
  valueFmt?: (value: number) => string;
}): Promise<string> {
  const { rows, title, color, valueFmt = pyG } = options;
  if (rows.length === 0) {
    return "";
  }
  const values = rows.map(([, value]) => value);
  return chartCard(
    vlBarH({
      labels: rows.map(([label]) => label),
      values,
      color: color || COLORS.teal_400,
      xTitle: "",
      valueLabels: values.map(valueFmt),
    }),
    title,
  );
}

export async function renderHeatmap(options: {
  xLabels: readonly string[];
  yLabels: readonly string[];
  cells: readonly (readonly number[])[];
  scale: ColorScale;
  title: string;
  valueFmt?: (value: number) => string;
  safetyMask?: readonly (readonly boolean[])[] | null;
}): Promise<string> {
  const { xLabels, yLabels, cells, scale, title, safetyMask } = options;
  const valueFmt = options.valueFmt ?? pyPercent;
  if (xLabels.length === 0 || yLabels.length === 0) {
    return "";
  }
  const cellAt = (y: number, x: number) => (cells[y] as number[])[x] as number;
  const grid = <T>(cell: (y: number, x: number) => T): T[][] =>
    yLabels.map((_, y) => xLabels.map((__, x) => cell(y, x)));
  return chartCard(
    vlHeatmap({
      xLabels,
      yLabels,
      cellColors: grid((y, x) =>
        cellAt(y, x) < 0 ? "#e4e2df" : scaleColor(cellAt(y, x), scale),
      ),
      cellTexts: grid((y, x) =>
        cellAt(y, x) < 0 ? "-" : valueFmt(cellAt(y, x)),
      ),
      safetyMask: safetyMask
        ? grid((y, x) => Boolean((safetyMask[y] as boolean[])[x]))
        : null,
    }),
    title,
  );
}

export async function renderHistogram(options: {
  values: readonly number[];
  bins: number;
  title: string;
}): Promise<string> {
  const { values, bins, title } = options;
  if (values.length === 0 || bins <= 0) {
    return "";
  }
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  return chartCard(vlHistogram({ values, bins, mean }), title);
}

export async function renderLineChart(options: {
  xLabels: readonly string[];
  series: readonly (readonly [string, readonly (number | null)[]])[];
  title: string;
}): Promise<string> {
  const { xLabels, series, title } = options;
  if (xLabels.length === 0 || series.length === 0) {
    return "";
  }
  return chartCard(vlLine({ xLabels, series }), title);
}

export async function renderSparkline(
  values: readonly number[],
): Promise<string> {
  return values.length === 0 ? "" : renderSvg(vlSparkline({ values }));
}

export function entryOutcome(entry: {
  error?: string | null;
  terminated_by?: string | null;
  goal_achieved?: boolean | null;
}): { label: string; status: CardStatus } {
  if (entry.error || entry.terminated_by === "error") {
    return { label: "Error", status: "warn" };
  }
  return entry.goal_achieved
    ? { label: "Goal met", status: "pass" }
    : { label: "Goal missed", status: "fail" };
}
