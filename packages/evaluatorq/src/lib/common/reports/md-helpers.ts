import { pythonStrip } from "../sanitize.js";
import { LINE_BREAKS } from "../unified-diff.js";
import { esc, pct } from "./html-helpers.js";
import { groupThousands, pyFixed, pyRound } from "./number-format.js";

export { pct };

const LINE_BREAK_GROUP = new RegExp(`(${LINE_BREAKS})`);

export const CACHED_TOKENS_LABEL = "Cached Input Tokens";

export function fmtCost(cost: number | null | undefined): string {
  if (cost === null || cost === undefined) {
    return "n/a";
  }
  return `$${groupThousands(pyFixed(cost, 4))}`;
}

export function costCoverage(pricedCalls: number, calls: number): string {
  if (pricedCalls > 0 && pricedCalls < calls) {
    return ` (${groupThousands(String(pricedCalls))} of ${groupThousands(String(calls))} calls)`;
  }
  return "";
}

export function fmtCachedTokens(
  cachedTokens: number,
  inputTokens: number,
): string {
  const count = groupThousands(pyFixed(cachedTokens, 0));
  if (inputTokens <= 0) {
    return count;
  }
  return `${count} (${pct(cachedTokens / inputTokens)} of input tokens)`;
}

export function bar(rate: number | null | undefined, width = 10): string {
  if (rate === null || rate === undefined) {
    return `${"░".repeat(width)} ${pct(rate)}`;
  }
  const filled = pyRound(rate * width);
  return `${"█".repeat(Math.max(0, filled))}${"░".repeat(Math.max(0, width - filled))} ${pct(rate)}`;
}

export function boldBar(
  rate: number | null | undefined,
  threshold = 0.5,
): string {
  const cell = bar(rate);
  return rate !== null && rate !== undefined && rate > threshold
    ? `**${cell}**`
    : cell;
}

function tableRow(cells: readonly string[]): string {
  return `| ${cells.join(" | ")} |`;
}

function sanitizedRow(row: readonly unknown[]): string {
  return tableRow(
    row.map((cell) =>
      String(cell).replaceAll("|", "\\|").replaceAll("\n", " "),
    ),
  );
}

export function mdTable(
  headers: readonly string[],
  rows: readonly (readonly unknown[])[],
  rightAlign: ReadonlySet<number> = new Set(),
): string {
  return [
    tableRow(headers),
    tableRow(headers.map((_, i) => (rightAlign.has(i) ? "---:" : "---"))),
    ...rows.map(sanitizedRow),
  ].join("\n");
}

export function centerTable(
  headers: readonly string[],
  rows: readonly (readonly unknown[])[],
): string {
  return [
    tableRow(headers),
    tableRow(headers.map(() => ":---:")),
    ...rows.map(sanitizedRow),
  ].join("\n");
}

export function truncate(text: string, maxChars = 800): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) {
    return text;
  }
  return `${chars.slice(0, maxChars).join("")}\n\n*[truncated: full text in report JSON]*`;
}

function indent(text: string, prefix: string): string {
  return text
    .split(LINE_BREAK_GROUP)
    .map((part, i) => (i % 2 === 0 && pythonStrip(part) ? prefix + part : part))
    .join("");
}

export function detailsBlock(summary: string, body: string): string {
  return `<details>\n<summary>${esc(summary)}</summary>\n\n${indent(pythonStrip(body), "  ")}\n\n</details>`;
}
