import { esc, pct } from "../common/reports/html-helpers.js";
import { pyFixed, pyRound } from "../common/reports/number-format.js";
export interface DonutSegment {
  label: string;
  value: number;
  color: string;
}
export function donut(
  segments: readonly DonutSegment[],
  centerValue: string,
  centerLabel: string,
): string {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0),
    radius = 60,
    circ = 2 * Math.PI * radius,
    arcs: string[] = [];
  let offset = 0;
  for (const segment of segments) {
    if (segment.value <= 0 || total <= 0) continue;
    const length = (circ * segment.value) / total;
    arcs.push(
      `<circle cx="75" cy="75" r="${radius}" fill="none" stroke="${segment.color}" stroke-width="18" stroke-dasharray="${pyFixed(length, 1)} ${pyFixed(circ - length, 1)}" stroke-dashoffset="${pyFixed(-offset, 1)}"/>`,
    );
    offset += length;
  }
  const legend = segments
    .filter((segment) => segment.value > 0)
    .map(
      (segment) =>
        `<li><span class="donut-key" style="background:${segment.color}"></span>${esc(segment.label)} · ${segment.value}</li>`,
    )
    .join("");
  return `<div class="donut-wrap"><div class="donut"><svg width="150" height="150" viewBox="0 0 150 150">${arcs.join("")}</svg><div class="donut-center"><span class="donut-value">${esc(centerValue)}</span><span class="donut-label">${esc(centerLabel)}</span></div></div><ul class="donut-legend">${legend}</ul></div>`;
}

type Row = Record<string, unknown>;
const n = (value: unknown): number => (typeof value === "number" ? value : 0);
const list = (value: unknown): Row[] =>
  Array.isArray(value) ? (value as Row[]) : [];
const text = (value: unknown): string =>
  value == null
    ? "None"
    : value === true
      ? "True"
      : value === false
        ? "False"
        : String(value);
export const shortModel = (model: string): string =>
  model.split("/").at(-1) ?? "";
export function focusTier(risk: number): [string, string, string] {
  return risk >= 2
    ? ["P1", "Critical priority", "var(--red-600)"]
    : risk >= 1
      ? ["P2", "High priority", "var(--orange-600)"]
      : ["P3", "Medium priority", "var(--amber-600)"];
}
function confidencePill(confidence?: string | null): string {
  if (!confidence) return "";
  const label = confidence.toUpperCase(),
    tone =
      (
        {
          HIGH: "#025558",
          MEDIUM: "var(--orange-700)",
          LOW: "var(--red-700)",
        } as Record<string, string>
      )[label] ?? "#025558";
  return `<span class="es-confidence" style="border-color:${tone};color:${tone}">${esc(label)} CONFIDENCE</span>`;
}
export function callout(
  bodyHtml: string,
  options: { label?: string; confidence?: string | null } = {},
): string {
  return `<div class="exec-summary"><div class="es-head"><span class="es-label">${esc(options.label ?? "Executive summary")}</span>${confidencePill(options.confidence)}</div><p class="es-body">${bodyHtml}</p></div>`;
}
export function execSummary(options: {
  summaryData: Row;
  heatmapData: Row;
  confidence?: string | null;
  label?: string;
}): string {
  const { summaryData: s, heatmapData: h } = options,
    total = n(s.total_conversations),
    errors = n(s.errors);
  if (!total) return "";
  if (errors && errors >= total)
    return callout(
      `No goal verdict is available because all <strong>${total}</strong> conversations errored.`,
      { label: options.label, confidence: null },
    );
  const personas = Array.isArray(h.personas) ? h.personas : [],
    scenarios = Array.isArray(h.scenarios) ? h.scenarios : [];
  let sentence = `Across <strong>${total}</strong> conversations (${personas.length} personas &times; ${scenarios.length} scenarios), the agent achieved a <strong>${pct(n(s.success_rate))}</strong> goal-completion rate at an average score of <strong>${pyFixed(n(s.avg_goal_completion_score), 2)}</strong>.`;
  if (errors)
    sentence += ` <strong>${total - errors}/${total}</strong> conversations completed and <strong>${errors}</strong> errored; the rate and average score above use all ${total} conversations.`;
  const scored = list(h.cells).filter(
    (cell) => n(cell.completed_conversations ?? cell.n) > 0,
  );
  const best = scored.reduce<Row | undefined>(
      (best, cell) =>
        !best || n(cell.success_rate) > n(best.success_rate) ? cell : best,
      undefined,
    ),
    worst = scored.reduce<Row | undefined>(
      (worst, cell) =>
        !worst || n(cell.success_rate) < n(worst.success_rate) ? cell : worst,
      undefined,
    );
  if (best && worst && best !== worst)
    sentence += ` It performed best on <strong>${esc(text(best.persona))} &times; ${esc(text(best.scenario))}</strong> (${pct(n(best.success_rate))}) and weakest on <strong>${esc(text(worst.persona))} &times; ${esc(text(worst.scenario))}</strong> (${pct(n(worst.success_rate))}).`;
  return callout(sentence, {
    label: options.label,
    confidence: options.confidence,
  });
}
export function tag(value: string, tone?: string | null): string {
  if (!value) return "";
  const color = (
    {
      red: "var(--red-600)",
      green: "var(--green-600)",
      amber: "var(--amber-600)",
      teal: "var(--teal-600)",
    } as Record<string, string>
  )[tone ?? ""];
  return `<span class="rk-tag"${color ? ` style="color:${color};border-color:${color}"` : ""}>${esc(value)}</span>`;
}
export function dial(
  valueText: string,
  fraction: number,
  options: { radius: number; stroke: number; color: string; sub?: string },
): string {
  const { radius, stroke, color } = options,
    size = (radius + stroke) * 2,
    cx = pyFixed(size / 2, 1),
    circ = 2 * Math.PI * radius,
    dash = Math.max(0, Math.min(1, fraction)) * circ;
  const sub = options.sub
    ? `<tspan x="${cx}" dy="1.2em" font-size="10" font-weight="500" fill="var(--text-faint)">${esc(options.sub)}</tspan>`
    : "";
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" class="rk-dial"><circle cx="${cx}" cy="${cx}" r="${radius}" fill="none" stroke="var(--chart-track)" stroke-width="${stroke}"></circle><circle cx="${cx}" cy="${cx}" r="${radius}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${pyFixed(dash, 1)} ${pyFixed(circ, 1)}" transform="rotate(-90 ${cx} ${cx})"></circle><text x="${cx}" y="${cx}" text-anchor="middle" dominant-baseline="middle" font-size="14" font-weight="600" fill="var(--text-strong)">${esc(valueText)}${sub}</text></svg>`;
}
const PILL_TONES: Record<string, { bg: string; fg: string; dot: string }> = {
  danger: {
    bg: "var(--red-100)",
    fg: "var(--red-700)",
    dot: "var(--outcome-vulnerable)",
  },
  "danger-solid": { bg: "var(--red-700)", fg: "#fff", dot: "#fff" },
  warn: {
    bg: "var(--amber-100)",
    fg: "var(--red-700)",
    dot: "var(--outcome-error)",
  },
  good: {
    bg: "var(--green-100)",
    fg: "var(--teal-600)",
    dot: "var(--outcome-resistant)",
  },
  neutral: {
    bg: "var(--sunken)",
    fg: "var(--text-muted)",
    dot: "var(--text-muted)",
  },
};
export function pill(
  value: string,
  options: { tone: string; dot?: boolean },
): string {
  const colors =
    PILL_TONES[options.tone] ??
    (PILL_TONES.neutral as { bg: string; fg: string; dot: string });
  return `<span class="rk-pill" style="background:${colors.bg};color:${colors.fg}">${options.dot ? `<span class="rk-pill-dot" style="background:${colors.dot}"></span>` : ""}${esc(value)}</span>`;
}
export function severityPill(level: string): string {
  const chars = Array.from(level || ""),
    key = level.toLowerCase();
  return pill(
    (chars[0]?.toUpperCase() ?? "") + chars.slice(1).join("").toLowerCase(),
    {
      tone:
        (
          {
            critical: "danger-solid",
            high: "warn",
            medium: "neutral",
            low: "good",
          } as Record<string, string>
        )[key] ?? "neutral",
    },
  );
}
export function outcomePill(status: string): string {
  const [tone, label] = (
    {
      vulnerable: ["danger", "Vulnerable"],
      resistant: ["good", "Resistant"],
      error: ["warn", "Error"],
    } as Record<string, [string, string]>
  )[status.toLowerCase()] ?? ["neutral", status || ""];
  return pill(label, { tone, dot: true });
}
export function panel(
  title: string,
  body: string,
  options: { sub?: string | null; info?: string | null } = {},
): string {
  if (!title) return "";
  const sub = options.sub
      ? `<div class="rk-panel-sub">${esc(options.sub)}</div>`
      : "",
    info = options.info
      ? `<span class="rk-panel-info" title="${esc(options.info)}" role="img" aria-label="${esc(options.info)}">&#9432;</span>`
      : "";
  return `<div class="rk-panel"><div class="rk-panel-title">${esc(title)}${info}</div>${sub}<div class="rk-panel-body">${body}</div></div>`;
}
export type Rgb = readonly [number, number, number];
export type HeatScale = readonly (readonly [number, string | Rgb])[];
export const SCALE_HEAT_RT: HeatScale = [
  [0, "#f3f1ee"],
  [0.5, "#ff8f34"],
  [1, "#df5325"],
];
const HEAT_STOPS: HeatScale = [
  [0, [0xdf, 0x53, 0x25]],
  [0.5, [0xff, 0x8f, 0x34]],
  [1, [0x29, 0x9d, 0x8f]],
];
const toRgb = (color: string | Rgb): Rgb =>
  typeof color === "string"
    ? [
        Number.parseInt(color.replace(/^#+/, "").slice(0, 2), 16),
        Number.parseInt(color.replace(/^#+/, "").slice(2, 4), 16),
        Number.parseInt(color.replace(/^#+/, "").slice(4, 6), 16),
      ]
    : color;
const rgbHex = (color: Rgb): string =>
  `#${color.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
export function interpColor(
  value: number,
  stops: HeatScale = HEAT_STOPS,
): string {
  const v = Math.max(0, Math.min(1, value)),
    norm = stops.map(([position, color]) => [position, toRgb(color)] as const);
  for (let i = 0; i < norm.length - 1; i++) {
    const [lo, c0] = norm[i] as readonly [number, Rgb],
      [hi, c1] = norm[i + 1] as readonly [number, Rgb];
    if (lo <= v && v <= hi) {
      const t = hi === lo ? 0 : (v - lo) / (hi - lo);
      return rgbHex(
        c0.map((a, index) =>
          pyRound(a + ((c1[index] ?? 0) - a) * t),
        ) as unknown as Rgb,
      );
    }
  }
  const last = norm.at(-1);
  if (!last) throw new RangeError("Color scale requires at least one stop");
  return rgbHex(last[1]);
}
export function barRows(
  rows: readonly (readonly [string, number])[],
  options: {
    width: number;
    labelWidth: number;
    color?: string;
    format?: (value: number) => string;
    colorScale?: HeatScale | null;
    maxValue?: number | null;
  },
): string {
  if (!rows.length) return "";
  const { width, labelWidth } = options,
    max =
      options.maxValue ?? (Math.max(...rows.map(([, value]) => value)) || 1),
    track = Math.max(width - labelWidth - 56, 10),
    height = rows.length * 28,
    parts = [
      `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" class="rk-bar-rows">`,
    ];
  for (const [index, [label, value]] of rows.entries()) {
    const y = index * 28,
      cy = y + 14,
      barWidth = max ? (value / max) * track : 0,
      fill = options.colorScale?.length
        ? interpColor(value / max, options.colorScale)
        : (options.color ?? "var(--chart-2)");
    parts.push(
      `<text x="${labelWidth - 8}" y="${pyFixed(cy, 1)}" text-anchor="end" dominant-baseline="middle" font-size="12" fill="var(--text-body)">${esc(label)}</text>`,
      `<rect x="${labelWidth}" y="${pyFixed(y + 7, 1)}" width="${track}" height="14" rx="3" fill="var(--chart-track)"></rect>`,
      `<rect x="${labelWidth}" y="${pyFixed(y + 7, 1)}" width="${pyFixed(barWidth, 1)}" height="14" rx="3" fill="${fill}"></rect>`,
      `<text x="${pyFixed(labelWidth + barWidth + 8, 1)}" y="${pyFixed(cy, 1)}" dominant-baseline="middle" font-family="var(--font-sans)" font-size="11" font-weight="600" fill="var(--text-strong)">${esc(options.format ? options.format(value) : String(value))}</text>`,
    );
  }
  return `${parts.join("")}</svg>`;
}
export function histogram(
  values: readonly number[],
  options: { bins?: number; meanLine?: boolean } = {},
): string {
  if (!values.length) return "";
  const bins = options.bins ?? 10;
  if (!Number.isInteger(bins) || bins < 1)
    throw new RangeError("Histogram bins must be a positive integer");
  let lo = Math.min(...values),
    hi = Math.max(...values);
  if (lo === hi) {
    lo -= 0.5;
    hi += 0.5;
  }
  const counts = Array.from({ length: bins }, () => 0),
    span = (hi - lo) / bins;
  for (const value of values) {
    const index = span
      ? Math.min(Math.trunc((value - lo) / span), bins - 1)
      : 0;
    counts[index] = (counts[index] ?? 0) + 1;
  }
  const max = Math.max(...counts) || 1,
    plotWidth = 598,
    plotHeight = 170,
    barWidth = plotWidth / bins - 2,
    parts = [
      '<svg viewBox="0 0 640 200" width="640" height="200" class="rk-histogram">',
    ];
  for (let i = 0; i < 3; i++) {
    const gy = 10 + (plotHeight * i) / 2;
    parts.push(
      `<line x1="32" y1="${pyFixed(gy, 1)}" x2="630" y2="${pyFixed(gy, 1)}" stroke="var(--chart-grid)" stroke-width="1"></line>`,
      `<text x="26" y="${pyFixed(gy + 3, 1)}" text-anchor="end" font-family="var(--font-sans)" font-size="10" fill="var(--text-faint)">${pyRound(max * (1 - i / 2))}</text>`,
    );
  }
  for (const [index, count] of counts.entries()) {
    const height = plotHeight * (count / max),
      x = 32 + index * (plotWidth / bins) + 1,
      y = 10 + plotHeight - height;
    parts.push(
      `<rect x="${pyFixed(x, 1)}" y="${pyFixed(y, 1)}" width="${pyFixed(barWidth, 1)}" height="${pyFixed(height, 1)}" rx="2" fill="var(--chart-2)"></rect>`,
    );
  }
  parts.push(
    `<text x="32" y="196" font-family="var(--font-sans)" font-size="10" fill="var(--text-faint)">${pyFixed(lo, 2)}</text>`,
    `<text x="630" y="196" text-anchor="end" font-family="var(--font-sans)" font-size="10" fill="var(--text-faint)">${pyFixed(hi, 2)}</text>`,
  );
  if (options.meanLine !== false) {
    const mean = values.reduce((a, b) => a + b, 0) / values.length,
      mx =
        hi !== lo
          ? 32 + ((mean - lo) / (hi - lo)) * plotWidth
          : 32 + plotWidth / 2;
    parts.push(
      `<line x1="${pyFixed(mx, 1)}" y1="10" x2="${pyFixed(mx, 1)}" y2="180" stroke="var(--orange-500)" stroke-width="1.5" stroke-dasharray="4 3"></line>`,
    );
  }
  return `${parts.join("")}</svg>`;
}
export function lineChart(
  xLabels: readonly unknown[],
  series: Readonly<Record<string, readonly (number | null)[]>>,
): string {
  if (!Object.keys(series).length) return "";
  const count = xLabels.length,
    xAt = (index: number) =>
      36 + (count > 1 ? (668 * index) / (count - 1) : 334),
    yAt = (value: number) => 16 + 216 * (1 - Math.max(0, Math.min(1, value))),
    parts = [
      '<svg viewBox="0 0 720 260" width="720" height="260" class="rk-line-chart" role="img">',
    ];
  for (const [value, label] of [
    [0, "0.0"],
    [0.25, "0.3"],
    [0.5, "0.5"],
    [0.75, "0.8"],
    [1, "1.0"],
  ] as const) {
    const gy = 16 + 216 * (1 - value);
    parts.push(
      `<line x1="36" y1="${pyFixed(gy, 1)}" x2="704" y2="${pyFixed(gy, 1)}" stroke="var(--chart-grid)" stroke-width="1"></line>`,
      `<text x="30" y="${pyFixed(gy + 3, 1)}" text-anchor="end" font-family="var(--font-sans)" font-size="10" fill="var(--text-faint)">${label}</text>`,
    );
  }
  for (const [index, label] of xLabels.entries())
    parts.push(
      `<text x="${pyFixed(xAt(index), 1)}" y="248" text-anchor="middle" font-family="var(--font-sans)" font-size="10" fill="var(--text-faint)">${esc(text(label))}</text>`,
    );
  const legends: string[] = [];
  for (const [index, [name, values]] of Object.entries(series).entries()) {
    const color = `var(--chart-${(index % 4) + 1})`;
    let run: [number, number][] = [];
    const flush = () => {
      if (run.length > 1)
        parts.push(
          `<polyline points="${run.map(([x, y]) => `${pyFixed(x, 1)},${pyFixed(y, 1)}`).join(" ")}" fill="none" stroke="${color}" stroke-width="2"></polyline>`,
        );
      run = [];
    };
    for (const [i, value] of values.entries()) {
      if (value == null) flush();
      else run.push([xAt(i), yAt(value)]);
    }
    flush();
    for (const [i, value] of values.entries())
      if (value != null)
        parts.push(
          `<circle cx="${pyFixed(xAt(i), 1)}" cy="${pyFixed(yAt(value), 1)}" r="2.5" fill="white" stroke="${color}" stroke-width="1.5"></circle>`,
        );
    if (values.some((value) => value != null))
      legends.push(
        `<span class="rk-legend-item"><span class="rk-legend-swatch" style="background:${color}"></span>${esc(name)}</span>`,
      );
  }
  return `${parts.join("")}</svg><div class="rk-legend">${legends.join("")}</div>`;
}
export function heatmap(
  rowLabels: readonly string[],
  colLabels: readonly string[],
  cells: readonly Row[],
  options: {
    rowKey?: string;
    colKey?: string;
    valueKey?: string;
    colorScale?: HeatScale | null;
    renderValue?: (cell: Row, text: string) => string;
  } = {},
): string {
  const rowKey = options.rowKey ?? "persona",
    colKey = options.colKey ?? "scenario",
    valueKey = options.valueKey ?? "success_rate",
    valueHtml = options.renderValue ?? ((_cell: Row, value: string) => value),
    lookup = new Map<string, Map<unknown, Row>>();
  for (const cell of cells) {
    const group = lookup.get(String(cell[rowKey])) ?? new Map<unknown, Row>();
    group.set(cell[colKey], cell);
    lookup.set(String(cell[rowKey]), group);
  }
  const header = colLabels
    .map((label) => `<th class="rk-heat-col">${esc(label)}</th>`)
    .join("");
  const body = rowLabels
    .map((label) => {
      const columns = colLabels
        .map((column) => {
          const cell = lookup.get(label)?.get(column);
          if (!cell) return '<td class="rk-heat-cell rk-heat-empty">-</td>';
          const rate = Object.hasOwn(cell, valueKey) ? cell[valueKey] : 0;
          if (
            rate == null ||
            (cell.completed_conversations === 0 &&
              n(cell.errored_conversations) > 0)
          ) {
            const title = `No completed conversations; ${n(cell.errored_conversations)} errored.`;
            return `<td class="rk-heat-cell rk-heat-no-verdict" title="${esc(title)}" aria-label="${esc(title)}">${valueHtml(cell, "n/a")}</td>`;
          }
          const value = n(rate),
            background = interpColor(value, options.colorScale ?? undefined),
            ink = value <= 0.55 ? "var(--ink-900)" : "#fff";
          return `<td class="rk-heat-cell" style="background:${background};color:${ink}">${valueHtml(cell, pct(value))}</td>`;
        })
        .join("");
      return `<tr><th class="rk-heat-row">${esc(label)}</th>${columns}</tr>`;
    })
    .join("");
  return `<table class="rk-heatmap"><thead><tr><th></th>${header}</tr></thead><tbody>${body}</tbody></table>`;
}
export function metaGrid(
  items: readonly (readonly [string, string | null])[],
): string {
  const values = items.filter(([, value]) => value != null && value !== "");
  return values.length
    ? `<div class="rk-meta-grid">${values.map(([key, value]) => `<div class="rk-meta-item"><div class="rk-meta-key">${esc(key)}</div><div class="rk-meta-value">${esc(value as string)}</div></div>`).join("")}</div>`
    : "";
}
