import { esc } from "./html-helpers.js";
import { pyG } from "./number-format.js";
import { COLORS, QUALITATIVE } from "./palette.js";

export type VegaSpec = Record<string, unknown>;

interface VegaModules {
  compile(spec: VegaSpec): { spec: unknown };
  parse(spec: unknown): unknown;
  View: new (
    runtime: unknown,
    options: { renderer: string },
  ) => { toSVG(): Promise<string> };
}

const ORQ_VL_CONFIG: VegaSpec = {
  background: "transparent",
  // Server-side rendering has no brand webfonts and cannot resolve system-ui, so name concrete sans families.
  font: "Inter, Helvetica Neue, Helvetica, Arial, sans-serif",
  axis: {
    labelColor: COLORS.ink_700,
    titleColor: COLORS.ink_700,
    gridColor: COLORS.sand_400,
    gridOpacity: 0.6,
    domainColor: COLORS.sand_400,
    tickColor: COLORS.sand_400,
  },
  legend: { labelColor: COLORS.ink_700, titleColor: COLORS.ink_700 },
  view: { stroke: "transparent" },
  bar: { cornerRadiusEnd: 3 },
  range: { category: QUALITATIVE },
};

let modules: Promise<VegaModules | null> | undefined;
let warnedUnavailable = false;

function loadVega(): Promise<VegaModules | null> {
  modules ??= Promise.all([import("vega"), import("vega-lite")])
    .then(
      ([vega, vegaLite]) =>
        ({
          compile: vegaLite.compile,
          parse: vega.parse,
          View: vega.View,
        }) as unknown as VegaModules,
    )
    .catch(() => null);
  return modules;
}

export async function vlAvailable(): Promise<boolean> {
  return (await loadVega()) !== null;
}

function finalize(spec: VegaSpec): VegaSpec {
  return {
    ...spec,
    config: { ...ORQ_VL_CONFIG, ...((spec.config as VegaSpec) ?? {}) },
    $schema: spec.$schema ?? "https://vega.github.io/schema/vega-lite/v5.json",
  };
}

function isEmpty(spec: VegaSpec): boolean {
  return Object.keys(spec).length === 0;
}

export async function renderSvg(spec: VegaSpec): Promise<string> {
  if (isEmpty(spec)) {
    return "";
  }
  const loaded = await loadVega();
  if (!loaded) {
    if (!warnedUnavailable) {
      console.warn(
        "vega and vega-lite not installed; charts omitted from reports.",
      );
      warnedUnavailable = true;
    }
    return "";
  }
  try {
    const runtime = loaded.parse(loaded.compile(finalize(spec)).spec);
    return await new loaded.View(runtime, { renderer: "none" }).toSVG();
  } catch (error) {
    console.warn("Vega-Lite SVG render failed; chart omitted.", error);
    return "";
  }
}

export function renderEmbed(spec: VegaSpec, domId: string): string {
  if (isEmpty(spec)) {
    return "";
  }
  // Without this a data value containing </script> breaks out of the JSON island.
  const specJson = JSON.stringify(finalize(spec)).replaceAll("</", "<\\/");
  const safe = esc(domId);
  return (
    `<div id="${safe}" class="vega-chart"></div>` +
    `<script type="application/json" data-vega-for="${safe}">${specJson}</script>` +
    "<script>(function(){window.__orqVegaViews=window.__orqVegaViews||{};" +
    `var el=document.getElementById("${safe}");` +
    `var s=JSON.parse(document.querySelector('[data-vega-for="${safe}"]').textContent);` +
    "if(window.vegaEmbed&&el){vegaEmbed(el,s,{actions:false}).then(function(r){" +
    `window.__orqVegaViews["${safe}"]=r;});}})();</script>`
  );
}

const nominal = (field: string, extra: VegaSpec = {}): VegaSpec => ({
  field,
  type: "nominal",
  ...extra,
});
const quantitative = (field: string, extra: VegaSpec = {}): VegaSpec => ({
  field,
  type: "quantitative",
  ...extra,
});
const rowAxis = (field: string): VegaSpec =>
  nominal(field, { sort: null, title: null });
const literalColor = (field: string): VegaSpec =>
  nominal(field, { scale: null, legend: null });
const seriesColor = (): VegaSpec =>
  nominal("series", { legend: { title: null } });

export function vlBarH(options: {
  labels: readonly string[];
  values: readonly number[];
  color: string;
  xTitle: string;
  valueLabels?: readonly string[] | null;
  colors?: readonly string[] | null;
}): VegaSpec {
  const { labels, values, color, xTitle, valueLabels, colors } = options;
  if (labels.length === 0) {
    return {};
  }
  const rows = Array.from(
    { length: Math.min(labels.length, values.length) },
    (_, i) => {
      const value = values[i] as number;
      return {
        label: labels[i],
        value,
        text: valueLabels?.[i] ?? pyG(value),
        fill: colors?.[i] ?? color,
      };
    },
  );
  const y = rowAxis("label");
  const x = quantitative("value", { title: xTitle });
  return {
    data: { values: rows },
    encoding: { y, x },
    width: 420,
    height: { step: 24 },
    layer: [
      {
        mark: { type: "bar" },
        encoding: { y, x, color: literalColor("fill") },
      },
      {
        mark: { type: "text", align: "left", dx: 4, color: COLORS.ink_700 },
        encoding: {
          y: nominal("label", { sort: null }),
          x: quantitative("value"),
          text: nominal("text"),
        },
      },
    ],
  };
}

export function vlDonut(options: {
  labels: readonly string[];
  values: readonly number[];
  colors: readonly string[];
  centerLabel?: string;
}): VegaSpec {
  const { labels, values, colors, centerLabel = "" } = options;
  if (labels.length === 0) {
    return {};
  }
  const arc: VegaSpec = {
    data: {
      values: Array.from(
        { length: Math.min(labels.length, values.length, colors.length) },
        (_, i) => ({ label: labels[i], value: values[i], color: colors[i] }),
      ),
    },
    mark: { type: "arc", innerRadius: 60, tooltip: true },
    encoding: {
      theta: quantitative("value"),
      color: literalColor("color"),
      order: quantitative("value", { sort: "descending" }),
    },
  };
  if (!centerLabel) {
    return { ...arc, width: 240, height: 240 };
  }
  return {
    width: 240,
    height: 240,
    layer: [
      arc,
      {
        data: { values: [{ t: centerLabel }] },
        mark: {
          type: "text",
          fontSize: 20,
          fontWeight: "bold",
          color: COLORS.ink_700,
        },
        encoding: { text: nominal("t") },
      },
    ],
  };
}

export function vlHeatmap(options: {
  xLabels: readonly string[];
  yLabels: readonly string[];
  cellColors: readonly (readonly string[])[];
  cellTexts: readonly (readonly string[])[];
  safetyMask?: readonly (readonly boolean[])[] | null;
}): VegaSpec {
  const { xLabels, yLabels, cellColors, cellTexts, safetyMask } = options;
  if (xLabels.length === 0 || yLabels.length === 0) {
    return {};
  }
  const rows = yLabels.flatMap((y, yi) =>
    xLabels.map((x, xi) => ({
      x,
      y,
      fill: (cellColors[yi] as string[])[xi],
      text: (cellTexts[yi] as string[])[xi],
      safety: Boolean(safetyMask?.[yi]?.[xi]),
    })),
  );
  return {
    data: { values: rows },
    layer: [
      {
        mark: { type: "rect", tooltip: true },
        encoding: {
          x: nominal("x", { title: null }),
          y: nominal("y", { title: null }),
          color: literalColor("fill"),
          stroke: {
            condition: { test: "datum.safety", value: COLORS.red_400 },
            value: null,
          },
          strokeWidth: {
            condition: { test: "datum.safety", value: 3 },
            value: 0,
          },
        },
      },
      {
        mark: { type: "text", fontSize: 11 },
        encoding: {
          x: nominal("x"),
          y: nominal("y"),
          text: nominal("text"),
        },
      },
    ],
    width: 420,
    height: 200,
  };
}

export function vlHistogram(options: {
  values: readonly number[];
  bins: number;
  mean?: number | null;
}): VegaSpec {
  const { values, bins, mean } = options;
  if (values.length === 0 || bins <= 0) {
    return {};
  }
  const counts = new Array<number>(bins).fill(0);
  for (const value of values) {
    const index = Math.min(bins - 1, Math.max(0, Math.trunc(value * bins)));
    counts[index] = (counts[index] as number) + 1;
  }
  const layers: VegaSpec[] = [
    {
      mark: { type: "bar", color: COLORS.teal_400, tooltip: true },
      encoding: {
        x: quantitative("lo", { title: null }),
        x2: { field: "hi" },
        y: quantitative("c", { title: "Count" }),
      },
    },
    {
      mark: { type: "text", dy: -4, color: COLORS.ink_700 },
      encoding: {
        x: quantitative("mid"),
        y: quantitative("c"),
        text: quantitative("c"),
      },
    },
  ];
  if (mean !== null && mean !== undefined) {
    layers.push({
      data: { values: [{ m: mean }] },
      mark: { type: "rule", strokeDash: [4, 4], color: COLORS.orange_300 },
      encoding: { x: quantitative("m") },
    });
  }
  return {
    data: {
      values: counts.map((c, i) => ({
        lo: i / bins,
        hi: (i + 1) / bins,
        mid: (i + 0.5) / bins,
        c,
      })),
    },
    layer: layers,
    width: 420,
    height: 200,
  };
}

export function vlLine(options: {
  xLabels: readonly string[];
  series: readonly (readonly [string, readonly (number | null)[]])[];
}): VegaSpec {
  const { xLabels, series } = options;
  if (xLabels.length === 0 || series.length === 0) {
    return {};
  }
  const rows = series.flatMap(([name, ys]) =>
    xLabels.map((x, i) => ({ x, series: name, v: ys[i] ?? null })),
  );
  return {
    data: { values: rows },
    mark: { type: "line", point: { filled: false }, invalid: "filter" },
    encoding: {
      x: nominal("x", { title: null }),
      y: quantitative("v", { title: null }),
      color: seriesColor(),
      strokeDash: nominal("series"),
      shape: nominal("series"),
    },
    width: 420,
    height: 200,
  };
}

export function vlGroupedBar(options: {
  categories: readonly string[];
  series: readonly (readonly [string, readonly number[]])[];
  xTitle: string;
}): VegaSpec {
  const { categories, series, xTitle } = options;
  if (categories.length === 0 || series.length === 0) {
    return {};
  }
  const rows = series.flatMap(([name, values]) =>
    categories.flatMap((cat, i) =>
      i < values.length ? [{ cat, series: name, value: values[i] }] : [],
    ),
  );
  const y = rowAxis("cat");
  const x = quantitative("value", { title: xTitle });
  const yOffset = nominal("series");
  return {
    data: { values: rows },
    layer: [
      {
        mark: { type: "bar", tooltip: true },
        encoding: { y, x, yOffset, color: seriesColor() },
      },
      {
        // A zero-width bar is indistinguishable from "not measured", so label it.
        transform: [{ filter: "datum.value === 0" }],
        mark: {
          type: "text",
          align: "left",
          dx: 3,
          fontSize: 9,
          color: COLORS.ink_700,
        },
        encoding: { y, x, yOffset, text: { value: "0" } },
      },
    ],
    width: 420,
    height: { step: 16 },
  };
}

export function vlStackedBar(options: {
  labels: readonly string[];
  series: readonly (readonly [string, readonly number[]])[];
  xTitle: string;
  valueLabels?: readonly (readonly string[])[] | null;
  extraFields?: ReadonlyMap<string, VegaSpec> | null;
  tooltip?: readonly VegaSpec[] | null;
}): VegaSpec {
  const { labels, series, xTitle, valueLabels, extraFields, tooltip } = options;
  if (labels.length === 0 || series.length === 0) {
    return {};
  }
  const rows = series.flatMap(([name, values], si) =>
    labels.map((label, li) => {
      const value = values[li] ?? 0;
      return {
        label,
        series: name,
        value,
        text: valueLabels?.[si]?.[li] ?? pyG(value),
        ...(extraFields?.get(stackedBarKey(label, name)) ?? {}),
      };
    }),
  );
  return {
    data: { values: rows },
    encoding: {
      y: rowAxis("label"),
      x: quantitative("value", { title: xTitle, stack: "zero" }),
      color: seriesColor(),
      ...(tooltip ? { tooltip } : {}),
    },
    width: 420,
    height: { step: 24 },
    layer: [
      { mark: { type: "bar" } },
      {
        mark: { type: "text", align: "left", dx: 4, color: COLORS.ink_700 },
        encoding: {
          y: nominal("label", { sort: null }),
          x: quantitative("value", { stack: "zero" }),
          text: nominal("text"),
          color: { value: COLORS.ink_700 },
        },
      },
    ],
  };
}

export function stackedBarKey(label: string, series: string): string {
  return JSON.stringify([label, series]);
}

export function vlSparkline(options: { values: readonly number[] }): VegaSpec {
  if (options.values.length === 0) {
    return {};
  }
  return {
    data: { values: options.values.map((v, i) => ({ i, v })) },
    mark: { type: "bar", color: COLORS.teal_400 },
    encoding: {
      x: { field: "i", type: "ordinal", axis: null },
      y: quantitative("v", { axis: null }),
    },
    width: 80,
    height: 20,
  };
}
