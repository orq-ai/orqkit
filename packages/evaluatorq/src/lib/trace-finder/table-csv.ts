import { pyFloat } from "../common/reports/number-format.js";
import { pythonString, pythonStrip } from "../common/sanitize.js";
import { MATCH, resolveColumns } from "./columns.js";
import type { TraceClassification } from "./models.js";
import type { TraceRow } from "./rows.js";

const safeText = (value: string): string =>
  ["=", "+", "-", "@"].some((prefix) => pythonStrip(value).startsWith(prefix))
    ? `'${value}`
    : value;
function csvValue(value: unknown, floating = false, date = false): string {
  if (value == null) return "";
  if (date && typeof value === "string") return value.replace(/Z$/, "+00:00");
  if (typeof value === "string") return safeText(value);
  if (typeof value === "number")
    return floating ? pyFloat(value) : pythonString(value);
  return pythonString(value);
}
const quote = (value: string): string =>
  /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
export function exportTableCsv(
  rows: readonly TraceRow[],
  columnKeys: readonly string[] | null = null,
  options: {
    dimensions?: readonly string[];
    results?: Readonly<Record<string, TraceClassification>> | null;
  } = {},
): string {
  const columns = resolveColumns(columnKeys),
    headers: string[] = [],
    selectors: {
      key: string;
      value: (row: TraceRow) => unknown;
      dimension: number | null;
    }[] = [];
  for (const column of columns) {
    if (column.key === MATCH) {
      for (const [index, name] of (options.dimensions ?? []).entries()) {
        headers.push(name);
        selectors.push({ ...column, dimension: index });
      }
    } else {
      headers.push(column.label);
      selectors.push({ ...column, dimension: null });
    }
  }
  const lines = [headers.map((header) => quote(safeText(header))).join(",")];
  for (const row of rows) {
    const result = options.results?.[row.traceId],
      values = selectors.map((column) => {
        let value: unknown;
        if (column.dimension !== null) {
          const answer =
            result && !result.error ? result.answers[column.dimension] : null;
          value = answer && !answer.error ? answer.value : null;
        } else value = column.value(row);
        return quote(
          csvValue(
            value,
            column.key === "cost" ||
              column.key === "cache_pct" ||
              column.key === MATCH,
            column.key === "started",
          ),
        );
      });
    lines.push(values.join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}
