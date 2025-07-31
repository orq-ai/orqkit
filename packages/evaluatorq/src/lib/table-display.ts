import chalk from "chalk";
import { Effect } from "effect";
import stripAnsi from "strip-ansi";
import type { EvaluatorqResult } from "./types.js";

// Truncate string to fit within maxWidth (accounting for ANSI codes)
function truncate(str: string, maxWidth: number): string {
  const plainStr = stripAnsi(str);
  if (plainStr.length <= maxWidth) return str;

  // For strings with ANSI codes, we need to be more careful
  if (str !== plainStr) {
    // Simple approach: just use plain string and re-apply basic coloring if needed
    return `${plainStr.substring(0, maxWidth - 3)}...`;
  }

  return `${str.substring(0, maxWidth - 3)}...`;
}

// Pad string to width (accounting for ANSI codes)
function pad(
  str: string,
  width: number,
  align: "left" | "right" = "left",
): string {
  const actualLength = stripAnsi(str).length;
  const padding = Math.max(0, width - actualLength);

  if (align === "left") {
    return str + " ".repeat(padding);
  } else {
    return " ".repeat(padding) + str;
  }
}

// Format value with smart truncation
function formatValue(value: unknown, _maxWidth: number = 30): string {
  if (value === null || value === undefined) return "-";

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (typeof value === "number") {
    return String(value);
  }

  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "[object]";
    }
  }

  return String(value);
}

// Get terminal width with fallback
function getTerminalWidth(): number {
  return process.stdout.columns || 80;
}

// Calculate responsive column widths based on terminal width
function calculateResponsiveWidths(
  minWidths: number[],
  terminalWidth: number,
): number[] {
  const numColumns = minWidths.length;
  const separatorWidth = (numColumns - 1) * 3 + 4; // " │ " between columns and "│ " + " │" at edges
  const availableWidth = terminalWidth - separatorWidth;
  const totalMinWidth = minWidths.reduce((sum, w) => sum + w, 0);

  // If terminal is too narrow, just use minimum widths
  if (availableWidth <= totalMinWidth) {
    return minWidths;
  }

  // Calculate extra space and distribute proportionally
  const extraSpace = availableWidth - totalMinWidth;
  return minWidths.map((minWidth) => {
    const proportion = minWidth / totalMinWidth;
    return Math.floor(minWidth + extraSpace * proportion);
  });
}

// Simple table renderer with multi-line support
function renderDetailedTable(
  headers: string[],
  rows: Array<{ main: string[]; details?: string[] }>,
  colWidths: number[],
): string {
  const lines: string[] = [];

  // Calculate total width for detail rows
  // Total width = sum of column widths + (number of columns - 1) * 3 (for " │ " separators) + 4 (for "│ " and " │")
  const totalContentWidth =
    colWidths.reduce((sum, w) => sum + w, 0) + (colWidths.length - 1) * 3;

  // Top border
  const topBorder = `┌${colWidths.map((w) => "─".repeat(w + 2)).join("┬")}┐`;
  lines.push(topBorder);

  // Headers
  const headerRow = `│ ${headers.map((h, i) => pad(h, colWidths[i])).join(" │ ")} │`;
  lines.push(headerRow);

  // Header separator
  const headerSep = `├${colWidths.map((w) => "─".repeat(w + 2)).join("┼")}┤`;
  lines.push(headerSep);

  // Data rows with details
  rows.forEach((row, rowIndex) => {
    // Main row
    const mainRow = `│ ${row.main
      .map((cell, i) => pad(truncate(cell, colWidths[i]), colWidths[i]))
      .join(" │ ")} │`;
    lines.push(mainRow);

    // Detail rows (if any) - these span all columns
    if (row.details && row.details.length > 0) {
      row.details.forEach((detail) => {
        const detailContent = chalk.dim(`  └─ ${detail}`);
        const paddedDetail = pad(detailContent, totalContentWidth);
        const detailRow = `│ ${paddedDetail} │`;
        lines.push(detailRow);
      });
    }

    // Add separator after each row (except last)
    if (rowIndex < rows.length - 1) {
      const rowSep = `├${colWidths.map((w) => "─".repeat(w + 2)).join("┼")}┤`;
      lines.push(rowSep);
    }
  });

  // Bottom border
  const bottomBorder = `└${colWidths.map((w) => "─".repeat(w + 2)).join("┴")}┘`;
  lines.push(bottomBorder);

  return lines.join("\n");
}

// Create a summary display
function createSummaryDisplay(results: EvaluatorqResult): string {
  const totalDataPoints = results.length;
  const failedDataPoints = results.filter((r) => r.error).length;
  const totalJobs = results.reduce(
    (acc, r) => acc + (r.jobResults?.length || 0),
    0,
  );
  const failedJobs = results.reduce((acc, r) => {
    return acc + (r.jobResults?.filter((j) => j.error).length || 0);
  }, 0);

  const successRate =
    totalJobs > 0
      ? Math.round(((totalJobs - failedJobs) / totalJobs) * 100)
      : 0;

  const headers = ["Metric", "Value"];
  const rows = [
    { main: ["Total Data Points", chalk.cyan(String(totalDataPoints))] },
    {
      main: [
        "Failed Data Points",
        failedDataPoints > 0
          ? chalk.red(String(failedDataPoints))
          : chalk.green("0"),
      ],
    },
    { main: ["Total Jobs", chalk.cyan(String(totalJobs))] },
    {
      main: [
        "Failed Jobs",
        failedJobs > 0 ? chalk.red(String(failedJobs)) : chalk.green("0"),
      ],
    },
    {
      main: [
        "Success Rate",
        failedJobs === 0
          ? chalk.green("100%")
          : successRate >= 80
            ? chalk.green(`${successRate}%`)
            : successRate >= 50
              ? chalk.yellow(`${successRate}%`)
              : chalk.red(`${successRate}%`),
      ],
    },
  ];

  return renderDetailedTable(headers, rows, [20, 15]);
}

// Create the main results display with new layout
function createResultsDisplay(results: EvaluatorqResult): string {
  if (results.length === 0) return "";

  // Collect all unique job names and evaluator names
  const allJobNames = new Set<string>();
  const allEvaluatorNames = new Set<string>();

  results.forEach((result) => {
    result.jobResults?.forEach((jobResult) => {
      allJobNames.add(jobResult.jobName);
      jobResult.evaluatorScores?.forEach((score) => {
        allEvaluatorNames.add(score.evaluatorName);
      });
    });
  });

  const jobNames = Array.from(allJobNames);
  const evaluatorNames = Array.from(allEvaluatorNames);

  // Calculate column widths
  const minWidths = {
    response: 40,
    evaluator: 15,
  };

  // Build headers: [For each job: Response + evaluator columns]
  const headers: string[] = [];
  const minColWidths: number[] = [];

  // Add headers for each job
  jobNames.forEach((jobName) => {
    headers.push(`${jobName}`);
    minColWidths.push(minWidths.response);

    // Add evaluator columns
    evaluatorNames.forEach((evaluatorName) => {
      headers.push(evaluatorName);
      minColWidths.push(minWidths.evaluator);
    });
  });

  const rows: Array<{ main: string[]; details?: string[] }> = [];

  // Process each data point
  results.forEach((result, dataPointIndex) => {
    const row: string[] = [];
    const details: string[] = [];

    if (result.error) {
      // Fill remaining columns with error message
      jobNames.forEach(() => {
        row.push(chalk.red("ERROR"));
        // Add empty columns for evaluators
        evaluatorNames.forEach(() => {
          row.push("-");
        });
      });
      details.push(
        chalk.red(
          `Data point #${dataPointIndex} error: ${result.error.message}`,
        ),
      );
    } else if (result.jobResults) {
      // Process each job column
      jobNames.forEach((jobName) => {
        const jobResult = result.jobResults?.find(
          (jr) => jr.jobName === jobName,
        );

        if (jobResult) {
          const outputStr = formatValue(jobResult.output);

          // Add response column
          if (jobResult.error) {
            row.push(chalk.red("Error"));
            details.push(
              chalk.red(`${jobName} Error: ${jobResult.error.message}`),
            );
          } else {
            // Special truncation for context-retrieval responses
            let displayStr = outputStr;
            if (
              jobName === "context-retrieval" &&
              outputStr.includes("Retrieved context for user")
            ) {
              // Extract just the user ID from "Retrieved context for user user-123"
              const userMatch = outputStr.match(/user-\d+/);
              displayStr = userMatch
                ? `Retrieved for ${userMatch[0]}`
                : outputStr;
            }
            row.push(truncate(displayStr, minWidths.response));
            // Add full output to details if truncated or specially formatted
            if (
              outputStr.length > minWidths.response ||
              typeof jobResult.output === "object" ||
              displayStr !== outputStr
            ) {
              details.push(`${jobName} full output: ${outputStr}`);
            }
          }

          // Add evaluator score columns
          evaluatorNames.forEach((evaluatorName) => {
            const score = jobResult.evaluatorScores?.find(
              (s) => s.evaluatorName === evaluatorName,
            );

            if (score) {
              if (score.error) {
                row.push(chalk.red("ERROR"));
              } else if (typeof score.score === "boolean") {
                row.push(score.score ? chalk.green("PASS") : chalk.red("FAIL"));
              } else if (typeof score.score === "number") {
                row.push(chalk.yellow(score.score.toFixed(3)));
              } else {
                row.push(chalk.gray(String(score.score)));
              }
            } else {
              row.push("-");
            }
          });
        } else {
          // Job not found for this data point
          row.push("-");
          // Fill evaluator columns
          evaluatorNames.forEach(() => {
            row.push("-");
          });
        }
      });
    }

    rows.push({
      main: row,
      details: details.length > 0 ? details : undefined,
    });
  });

  const terminalWidth = getTerminalWidth();
  const responsiveWidths = calculateResponsiveWidths(
    minColWidths,
    terminalWidth,
  );
  return renderDetailedTable(headers, rows, responsiveWidths);
}

export const displayResultsTableEffect = (
  results: EvaluatorqResult,
): Effect.Effect<void, never, never> =>
  Effect.sync(() => {
    if (results.length === 0) {
      console.log(chalk.yellow("\nNo results to display.\n"));
      return;
    }

    // Clear line and move cursor
    console.log("\n");

    // Title
    console.log(chalk.bold.underline.white("EVALUATION RESULTS"));
    console.log("");

    // Summary
    console.log(chalk.bold.white("Summary:"));
    console.log(createSummaryDisplay(results));
    console.log("");

    // Detailed Results
    console.log(chalk.bold.white("Detailed Results:"));
    console.log(createResultsDisplay(results));
    console.log("");

    // Show tip
    console.log(
      chalk.dim(
        "💡 Tip: Details are shown below each row. Use print:false to get raw JSON results.",
      ),
    );
    console.log("");
  });
