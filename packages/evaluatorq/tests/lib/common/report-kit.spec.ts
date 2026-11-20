import { expect, it } from "bun:test";

import * as kit from "../../../src/lib/dashboard/report-kit.js";
import goldens from "../fixtures/report-kit-python-goldens.json" with {
  type: "json",
};

const call = (kind: string, args: unknown[]): unknown => {
  const a = args[0],
    b = args[1],
    c = args[2],
    d = args[3];
  switch (kind) {
    case "shortModel":
      return kit.shortModel(a as string);
    case "focusTier":
      return kit.focusTier(a as number);
    case "tag":
      return kit.tag(a as string, b as string | null);
    case "pill":
      return kit.pill(a as string, b as Parameters<typeof kit.pill>[1]);
    case "severityPill":
      return kit.severityPill(a as string);
    case "outcomePill":
      return kit.outcomePill(a as string);
    case "callout":
      return kit.callout(a as string, b as Parameters<typeof kit.callout>[1]);
    case "dial":
      return kit.dial(
        a as string,
        b as number,
        c as Parameters<typeof kit.dial>[2],
      );
    case "execSummary": {
      const raw = a as Record<string, unknown>;
      return kit.execSummary({
        summaryData: raw.summary_data as Record<string, unknown>,
        heatmapData: raw.heatmap_data as Record<string, unknown>,
        confidence: raw.confidence as string | null,
      });
    }
    case "barRows": {
      const options = b as Record<string, unknown>;
      return kit.barRows(a as [string, number][], {
        width: options.width as number,
        labelWidth: options.label_w as number,
        color: options.color as string,
        maxValue: options.max_value as number | null,
        colorScale: options.color_scale as kit.HeatScale | null,
      });
    }
    case "histogram": {
      const options = b as Record<string, unknown>;
      return kit.histogram(a as number[], {
        bins: options.bins as number,
        meanLine: options.mean_line as boolean,
      });
    }
    case "lineChart":
      return kit.lineChart(
        a as unknown[],
        b as Record<string, (number | null)[]>,
      );
    case "interpColor":
      return kit.interpColor(
        a as number,
        b == null ? undefined : (b as kit.HeatScale),
      );
    case "heatmap": {
      const options = d as Record<string, unknown>;
      return kit.heatmap(
        a as string[],
        b as string[],
        c as Record<string, unknown>[],
        { colorScale: options.color_scale as kit.HeatScale | null },
      );
    }
    case "panel":
      return kit.panel(
        a as string,
        b as string,
        c as Parameters<typeof kit.panel>[2],
      );
    case "metaGrid":
      return kit.metaGrid(a as [string, string | null][]);
    default:
      throw new Error(`Missing renderer ${kind}`);
  }
};
for (const [index, row] of goldens.cases.entries())
  it(`matches pinned dashboard ${row.kind} ${index}`, () =>
    expect(call(row.kind, row.args)).toEqual(row.expected));
