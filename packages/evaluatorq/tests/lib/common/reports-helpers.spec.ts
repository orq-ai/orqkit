import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  confirmRunPlan,
  renderPlanTable,
  writeTextReport,
} from "../../../src/lib/common/reports/console.js";
import {
  generateExecutiveSummary,
  truncateText,
} from "../../../src/lib/common/reports/executive-summary.js";
import {
  entryOutcome,
  humanizeDuration,
  parseHttpUrl,
  renderDonutChart,
  renderHeatmap,
  renderHistogram,
  scaleColor,
  svgBar,
  truncatePlain,
} from "../../../src/lib/common/reports/html-helpers.js";
import {
  bar,
  boldBar,
  costCoverage,
  detailsBlock,
  fmtCachedTokens,
  fmtCost,
  mdTable,
  truncate,
} from "../../../src/lib/common/reports/md-helpers.js";
import { renderMessageList } from "../../../src/lib/common/reports/messages.js";
import {
  pyFixed,
  pyG,
  pyPercent,
} from "../../../src/lib/common/reports/number-format.js";
import { ORQ_SCALE_HEAT } from "../../../src/lib/common/reports/palette.js";
import {
  renderHeaderMd,
  renderHtml,
  renderMarkdown,
} from "../../../src/lib/common/reports/render.js";
import { rateStyle } from "../../../src/lib/common/reports/rich-styles.js";
import {
  renderEmbed,
  renderSvg,
  vlBarH,
  vlHistogram,
  vlLine,
  vlSparkline,
} from "../../../src/lib/common/reports/vega.js";
import {
  LLMCallConfig,
  type ReportSection,
} from "../../../src/lib/contracts.js";

const section = (kind: string, title: string, body: string) =>
  ({ kind, title, body }) as unknown as ReportSection;

describe("Python number formats", () => {
  test.each([
    [0.125, 2, "0.12"],
    [2.5, 0, "2"],
    [3.5, 0, "4"],
    [1.005, 2, "1.00"],
    [-0.5, 0, "-0"],
    [1234.5, 0, "1234"],
  ])("pyFixed(%p, %p)", (value, places, expected) => {
    expect(pyFixed(value, places)).toBe(expected);
  });

  test.each([
    [0.125, "12%"],
    [0.5, "50%"],
    [0.005, "0%"],
    [1, "100%"],
  ])("pyPercent(%p)", (value, expected) => {
    expect(pyPercent(value)).toBe(expected);
  });

  test.each([
    [1e6, "1e+06"],
    [123456.5, "123456"],
    [0.0001, "0.0001"],
    [1e-5, "1e-05"],
    [1.5, "1.5"],
    [1234567, "1.23457e+06"],
    [100000, "100000"],
  ])("pyG(%p)", (value, expected) => {
    expect(pyG(value)).toBe(expected);
  });
});

describe("Markdown helpers", () => {
  test("cost and token cells", () => {
    expect(fmtCost(1234.5678)).toBe("$1,234.5678");
    expect(fmtCost(null)).toBe("n/a");
    expect(costCoverage(2, 5)).toBe(" (2 of 5 calls)");
    expect(costCoverage(5, 5)).toBe("");
    expect(fmtCachedTokens(500, 1000)).toBe("500 (50% of input tokens)");
  });

  test("bars round halves to even and tolerate out-of-range rates", () => {
    expect(bar(0.25)).toBe("██░░░░░░░░ 25%");
    expect(boldBar(0.75)).toBe("**████████░░ 75%**");
    expect(bar(null)).toBe("░░░░░░░░░░ n/a");
    expect(bar(-0.2)).toContain("░");
    expect(bar(1.3)).toContain("█");
  });

  test("tables escape pipes and flatten newlines", () => {
    expect(mdTable(["a", "b"], [["x|y", "1\n2"]], new Set([1]))).toBe(
      "| a | b |\n| --- | ---: |\n| x\\|y | 1 2 |",
    );
  });

  test("truncate counts code points and has no banned dash in the marker", () => {
    expect(truncate("😀😀", 2)).toBe("😀😀");
    expect(truncate("😀😀😀", 2)).toBe(
      "😀😀\n\n*[truncated: full text in report JSON]*",
    );
    expect(truncatePlain("abc", 1)).toBe(
      "a\n\n[truncated: full text in report JSON]",
    );
  });

  test("detailsBlock escapes the summary and indents non-blank lines", () => {
    expect(detailsBlock("<s>", " a\n\n b\n")).toBe(
      "<details>\n<summary>&lt;s&gt;</summary>\n\n  a\n\n   b\n\n</details>",
    );
  });
});

describe("HTML helpers", () => {
  test("parseHttpUrl accepts only http and https", () => {
    expect(parseHttpUrl("https://x.io/a")?.hostname).toBe("x.io");
    expect(parseHttpUrl("javascript:alert(1)")).toBeNull();
    expect(parseHttpUrl("ftp://x.io")).toBeNull();
    expect(parseHttpUrl(null)).toBeNull();
  });

  test("humanizeDuration", () => {
    expect(humanizeDuration(125.7)).toBe("2m 5s");
    expect(humanizeDuration(45.9)).toBe("45s");
    expect(humanizeDuration(0)).toBe("");
  });

  test("scaleColor interpolates and clamps", () => {
    const scale = [
      [0, "#000000"],
      [1, "#ffffff"],
    ] as const;
    expect(scaleColor(0.5, scale)).toBe("#808080");
    expect(scaleColor(-1, scale)).toBe("#000000");
    expect(scaleColor(2, scale)).toBe("#ffffff");
  });

  test("entryOutcome", () => {
    expect(entryOutcome({ error: "x" }).status).toBe("warn");
    expect(entryOutcome({ terminated_by: "error" }).label).toBe("Error");
    expect(entryOutcome({ goal_achieved: true }).label).toBe("Goal met");
    expect(entryOutcome({ goal_achieved: false }).status).toBe("fail");
  });

  test("rateStyle flips for lower-is-better rates", () => {
    expect(rateStyle(0.9)).toBe("green");
    expect(rateStyle(0.6)).toBe("yellow");
    expect(rateStyle(0.1)).toBe("red");
    expect(rateStyle(0.1, { higherIsBetter: false })).toBe("green");
  });
});

describe("charts", () => {
  test("vega specs carry Python's data rows", () => {
    expect(vlBarH({ labels: [], values: [], color: "#1", xTitle: "" })).toEqual(
      {},
    );
    const hist = vlHistogram({ values: [0.1, 1, -0.2], bins: 2 }) as {
      data: { values: { c: number }[] };
    };
    expect(hist.data.values.map((row) => row.c)).toEqual([2, 1]);
    const line = vlLine({ xLabels: ["a", "b"], series: [["s", [1]]] }) as {
      data: { values: { v: number | null }[] };
    };
    expect(line.data.values.map((row) => row.v)).toEqual([1, null]);
  });

  test("renderSvg produces an SVG with the data labels", async () => {
    const svg = await renderSvg(
      vlBarH({
        labels: ["alpha"],
        values: [3],
        color: "#123456",
        xTitle: "Count",
      }),
    );
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("alpha");
    expect(svg).toContain("#123456");
  });

  test("an unrenderable spec is omitted instead of throwing", async () => {
    const warn = mock(() => {});
    const original = console.warn;
    console.warn = warn;
    try {
      expect(await renderSvg({ mark: "not-a-mark" })).toBe("");
    } finally {
      console.warn = original;
    }
    expect(warn).toHaveBeenCalled();
  });

  test("chart helpers skip empty input and caption the rest", async () => {
    expect(
      await renderDonutChart({
        labels: ["a"],
        values: [0],
        colors: ["#000000"],
        title: "t",
      }),
    ).toBe("");
    expect(await renderHistogram({ values: [], bins: 3, title: "t" })).toBe("");
    const figure = await svgBar({ rows: [["a", 1.5]], title: "<T>" });
    expect(figure).toContain("<figcaption>&lt;T&gt;</figcaption>");
    expect(figure).toContain("<svg");
  });

  test("renderHeatmap marks absent cells", async () => {
    const figure = await renderHeatmap({
      xLabels: ["x", "y"],
      yLabels: ["p"],
      cells: [[0.5, -1]],
      scale: ORQ_SCALE_HEAT,
      title: "t",
    });
    expect(figure).toContain("50%");
    expect(figure).toContain(">-<");
  });

  test("renderEmbed keeps a data value inside the JSON island", () => {
    const html = renderEmbed(
      { mark: "bar", data: { values: [{ a: "</script>" }] } },
      "d1",
    );
    expect(html).toContain("<\\/script>");
    expect(html).not.toContain('"</script>');
    expect(renderEmbed({}, "d1")).toBe("");
  });

  test("a sparkline has no axes", () => {
    const spec = vlSparkline({ values: [1, 2] }) as {
      encoding: { y: { axis: unknown } };
    };
    expect(spec.encoding.y.axis).toBeNull();
  });
});

describe("renderers", () => {
  const renderers = {
    summary: (s: ReportSection) =>
      `## ${s.title}\n\n${(s as unknown as { body: string }).body}`,
    details: async (s: ReportSection) =>
      (s as unknown as { body: string }).body,
  } as never;

  test("renderMarkdown collapses, awaits and skips unknown kinds", async () => {
    const warn = mock(() => {});
    const original = console.warn;
    console.warn = warn;
    try {
      const out = await renderMarkdown(
        [
          section("summary", "T", "body"),
          section("details", "D", "plain"),
          section("nope", "N", "x"),
        ],
        {
          renderers,
          collapsedKinds: new Set(["summary"]),
          header: "H",
          footer: "F",
        },
      );
      expect(out).toBe(
        "H\n\n<details>\n<summary>T</summary>\n\n  body\n\n</details>\n\nplain\n\nF",
      );
    } finally {
      console.warn = original;
    }
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("renderHeaderMd and renderHtml", async () => {
    expect(renderHeaderMd({ title: "T", rows: [["a", "1"]] })).toBe(
      "# T\n\n**a:** 1  ",
    );
    const html = await renderHtml([], { renderers, head: "<title>x</title>" });
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("<head>\n<title>x</title>\n</head>");
  });

  test("renderMessageList escapes content and renders tool calls", () => {
    const html = renderMessageList(
      [
        { role: "user", content: "<b>hi</b>" },
        {
          role: "assistant",
          content: "\u001c",
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "f", arguments: "{}" },
            },
          ],
        },
        { role: "<x>", content: null },
      ],
      { roleLabels: { user: "U" }, classPrefix: "sim" },
    );
    expect(html).toContain("sim-msg sim-msg-user");
    expect(html).toContain("&lt;b&gt;hi&lt;/b&gt;");
    expect(html).toContain("[tool_call: f(");
    expect(html).not.toContain("\u001c");
    expect(html).toContain("sim-msg-unknown");
    expect(html).toContain("&lt;x&gt;");
  });
});

describe("console", () => {
  test("renderPlanTable draws a rounded box", () => {
    const lines: string[] = [];
    renderPlanTable({
      title: "Plan",
      rows: [["model", "m"]],
      output: { log: (t) => lines.push(t) },
    });
    expect(lines[1]?.startsWith("╭")).toBe(true);
    expect(lines.at(-1)?.startsWith("╰")).toBe(true);
    expect(lines.some((l) => l.includes("model"))).toBe(true);
  });

  test("confirmRunPlan skips the prompt when asked", async () => {
    await expect(
      confirmRunPlan({
        title: "P",
        rows: [],
        prompt: "go?",
        skipConfirm: true,
        output: { log: () => {} },
      }),
    ).resolves.toBe(true);
  });

  test("writeTextReport creates the directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "report-"));
    const error = console.error;
    console.error = () => {};
    try {
      const path = writeTextReport(join(dir, "a", "b"), {
        stem: "r",
        fmt: "md",
        content: "x",
      });
      expect(path.endsWith("r.md")).toBe(true);
      expect(readFileSync(path, "utf8")).toBe("x");
    } finally {
      console.error = error;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("executive summary", () => {
  function fakeClient(result: unknown) {
    const calls: Record<string, unknown>[] = [];
    const client = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            calls.push(params);
            if (result instanceof Error) {
              throw result;
            }
            return result;
          },
        },
      },
    };
    return { client: client as never, calls };
  }

  const reply = {
    choices: [{ message: { content: "  Summary. \n" } }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  };

  test("truncateText collapses whitespace and caps code points", () => {
    expect(truncateText("a  b\n c", 3)).toBe("a b…");
    expect(truncateText("a b", 3)).toBe("a b");
  });

  test("blank facts skip the call", async () => {
    const { client, calls } = fakeClient(reply);
    expect(
      await generateExecutiveSummary(" \n", { llmClient: client, model: "m" }),
    ).toEqual({ text: null, usage: null });
    expect(calls).toHaveLength(0);
  });

  test("the default call sends the cap and omits temperature", async () => {
    const { client, calls } = fakeClient(reply);
    const result = await generateExecutiveSummary("facts", {
      llmClient: client,
      model: "m",
    });
    expect(result.text).toBe("Summary.");
    expect(result.usage?.totalTokens).toBe(5);
    expect(calls[0]?.max_completion_tokens).toBe(400);
    expect("temperature" in (calls[0] ?? {})).toBe(false);
  });

  test("config values win and extraKwargs reach the request", async () => {
    const { client, calls } = fakeClient(reply);
    await generateExecutiveSummary("facts", {
      llmClient: client,
      model: "m",
      config: new LLMCallConfig({
        temperature: 0.2,
        maxTokens: 50,
        extraKwargs: { top_p: 0.5 },
      }),
    });
    expect(calls[0]).toMatchObject({
      temperature: 0.2,
      max_completion_tokens: 50,
      top_p: 0.5,
    });
  });

  test("a failure yields no text instead of throwing", async () => {
    const warn = mock(() => {});
    const original = console.warn;
    console.warn = warn;
    try {
      const { client } = fakeClient(new Error("boom"));
      expect(
        await generateExecutiveSummary("facts", {
          llmClient: client,
          model: "m",
        }),
      ).toEqual({ text: null, usage: null });
    } finally {
      console.warn = original;
    }
    expect(warn).toHaveBeenCalled();
  });
});
