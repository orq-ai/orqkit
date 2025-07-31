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

// Calculate averages for evaluator scores across all data points
function calculateEvaluatorAverages(results: EvaluatorqResult): {
  jobNames: string[];
  evaluatorNames: string[];
  averages: Map<
    string,
    Map<string, { value: string; color: (text: string) => string }>
  >;
} {
  // Collect all unique job names and evaluator names
  const allJobNames = new Set<string>();
  const allEvaluatorNames = new Set<string>();

  // Store all scores per evaluator per job
  const scoresByEvaluatorAndJob = new Map<
    string,
    Map<string, (number | boolean | string)[]>
  >();

  results.forEach((result) => {
    result.jobResults?.forEach((jobResult) => {
      allJobNames.add(jobResult.jobName);
      jobResult.evaluatorScores?.forEach((score) => {
        allEvaluatorNames.add(score.evaluatorName);

        if (!score.error) {
          if (!scoresByEvaluatorAndJob.has(score.evaluatorName)) {
            scoresByEvaluatorAndJob.set(score.evaluatorName, new Map());
          }
          const jobScores = scoresByEvaluatorAndJob.get(score.evaluatorName);
          if (jobScores && !jobScores.has(jobResult.jobName)) {
            jobScores.set(jobResult.jobName, []);
          }
          jobScores?.get(jobResult.jobName)?.push(score.score);
        }
      });
    });
  });

  const jobNames = Array.from(allJobNames);
  const evaluatorNames = Array.from(allEvaluatorNames);

  // Calculate averages
  const averages = new Map<
    string,
    Map<string, { value: string; color: (text: string) => string }>
  >();

  evaluatorNames.forEach((evaluatorName) => {
    const evaluatorAverages = new Map<
      string,
      { value: string; color: (text: string) => string }
    >();

    jobNames.forEach((jobName) => {
      const scores =
        scoresByEvaluatorAndJob.get(evaluatorName)?.get(jobName) || [];

      if (scores.length === 0) {
        evaluatorAverages.set(jobName, { value: "-", color: chalk.gray });
      } else {
        const firstScore = scores[0];

        if (typeof firstScore === "number") {
          // Calculate average for numeric scores
          const numericScores = scores as number[];
          const sum = numericScores.reduce((acc, score) => acc + score, 0);
          const avg = sum / numericScores.length;
          evaluatorAverages.set(jobName, {
            value: avg.toFixed(2),
            color: chalk.yellow,
          });
        } else if (typeof firstScore === "boolean") {
          // Calculate pass rate for boolean scores
          const passCount = scores.filter((score) => score === true).length;
          const passRate = (passCount / scores.length) * 100;
          evaluatorAverages.set(jobName, {
            value: `${passRate.toFixed(1)}%`,
            color:
              passRate === 100
                ? chalk.green
                : passRate >= 50
                  ? chalk.yellow
                  : chalk.red,
          });
        } else {
          // For strings, we ignore as per requirements
          evaluatorAverages.set(jobName, {
            value: "[string]",
            color: chalk.gray,
          });
        }
      }
    });

    averages.set(evaluatorName, evaluatorAverages);
  });

  return { jobNames, evaluatorNames, averages };
}

// Create the main results display with new layout
function createResultsDisplay(results: EvaluatorqResult): string {
  if (results.length === 0) return "";

  const { jobNames, evaluatorNames, averages } =
    calculateEvaluatorAverages(results);

  if (jobNames.length === 0 || evaluatorNames.length === 0) {
    return chalk.yellow("No job results or evaluators found.");
  }

  // Build headers: ["Evaluators"] + job names
  const headers = ["Evaluators", ...jobNames];

  // Calculate column widths
  const minColWidths = [20]; // First column for evaluator names
  jobNames.forEach(() => minColWidths.push(15)); // Job columns

  const rows: Array<{ main: string[]; details?: string[] }> = [];

  // Create a row for each evaluator
  evaluatorNames.forEach((evaluatorName) => {
    const row: string[] = [evaluatorName];

    jobNames.forEach((jobName) => {
      const avgData = averages.get(evaluatorName)?.get(jobName);
      if (avgData) {
        row.push(avgData.color(avgData.value));
      } else {
        row.push(chalk.gray("-"));
      }
    });

    rows.push({ main: row });
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
