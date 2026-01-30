import fs from "node:fs";

import chalk from "chalk";
import { Effect } from "effect";
import stripAnsi from "strip-ansi";

import type { EvaluatorqResult } from "./types.js";

// Color a percentage value: green >= 80%, yellow >= 50%, red below
function colorRate(rate: number): string {
  if (rate >= 80) return chalk.green(`${rate}%`);
  if (rate >= 50) return chalk.yellow(`${rate}%`);
  return chalk.red(`${rate}%`);
}

// Count evaluator scores that use the pass field
function countPassStats(results: EvaluatorqResult): {
  totalWithPass: number;
  totalPassed: number;
} {
  let totalWithPass = 0;
  let totalPassed = 0;

  for (const result of results) {
    for (const job of result.jobResults ?? []) {
      for (const score of job.evaluatorScores ?? []) {
        if (score.score.pass !== undefined) {
          totalWithPass++;
          if (score.score.pass === true) {
            totalPassed++;
          }
        }
      }
    }
  }

  return { totalWithPass, totalPassed };
}

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

  const { totalWithPass, totalPassed } = countPassStats(results);

  const headers = ["Metric", "Value"];
  const rows: Array<{ main: string[]; details?: string[] }> = [
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
        failedJobs === 0 ? chalk.green("100%") : colorRate(successRate),
      ],
    },
  ];

  if (totalWithPass > 0) {
    const passRate = Math.round((totalPassed / totalWithPass) * 100);
    const passLabel = `${passRate}% (${totalPassed}/${totalWithPass})`;
    const passColor =
      passRate === 100 ? chalk.green : passRate >= 80 ? chalk.yellow : chalk.red;
    rows.push({
      main: ["Pass Rate", passColor(passLabel)],
    });
  }

  return renderDetailedTable(headers, rows, [20, 15]);
}

// Calculate averages for evaluator scores across all data points
export function calculateEvaluatorAverages(results: EvaluatorqResult): {
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
    Map<string, (number | boolean | string | Record<string, unknown>)[]>
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
          jobScores?.get(jobResult.jobName)?.push(score.score.value);
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
        } else if (typeof firstScore === "object" && firstScore !== null) {
          // For structured data (e.g., BERT score, ROUGE_N), show placeholder
          evaluatorAverages.set(jobName, {
            value: "[structured]",
            color: chalk.gray,
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

  // Calculate column widths: evaluator name column + one per job
  const minColWidths = [20, ...jobNames.map(() => 15)];

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

// Collect and format error messages
function collectErrors(results: EvaluatorqResult): string[] {
  const errors: string[] = [];

  results.forEach((result, idx) => {
    if (result.error) {
      errors.push(`• Data point ${idx + 1}: ${result.error.message}`);
    }

    result.jobResults?.forEach((job) => {
      if (job.error) {
        errors.push(`• Job "${job.jobName}": ${job.error.message}`);
      }

      job.evaluatorScores?.forEach((score) => {
        if (score.error) {
          errors.push(
            `• Evaluator "${score.evaluatorName}": ${score.error.message}`,
          );
        }
      });
    });
  });

  return errors;
}

/**
 * Write detailed evaluation results to GitHub Actions step summary.
 * Only writes when GITHUB_STEP_SUMMARY environment variable is set.
 */
function writeGitHubStepSummary(
  evaluationName: string,
  results: EvaluatorqResult,
): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;

  const totalDataPoints = results.length;
  const failedDataPoints = results.filter((r) => r.error).length;
  const totalJobs = results.reduce(
    (acc, r) => acc + (r.jobResults?.length || 0),
    0,
  );
  const failedJobs = results.reduce((acc, r) => {
    return acc + (r.jobResults?.filter((j) => j.error).length || 0);
  }, 0);

  const { totalWithPass, totalPassed } = countPassStats(results);
  const passRate =
    totalWithPass > 0 ? Math.round((totalPassed / totalWithPass) * 100) : null;
  const statusEmoji =
    passRate !== null
      ? passRate === 100
        ? "✅"
        : "❌"
      : failedJobs > 0
        ? "❌"
        : "✅";

  let markdown = `### ${statusEmoji} ${evaluationName}\n\n`;

  // Summary stats
  markdown += `| Metric | Value |\n`;
  markdown += `|--------|-------|\n`;
  markdown += `| Data Points | ${totalDataPoints} |\n`;
  markdown += `| Failed Data Points | ${failedDataPoints} |\n`;
  markdown += `| Total Jobs | ${totalJobs} |\n`;
  markdown += `| Failed Jobs | ${failedJobs} |\n`;

  if (passRate !== null) {
    markdown += `| **Pass Rate** | **${passRate}% (${totalPassed}/${totalWithPass})** |\n`;
  }

  markdown += `\n`;

  // Evaluator results table
  const { jobNames, evaluatorNames, averages } =
    calculateEvaluatorAverages(results);

  if (jobNames.length > 0 && evaluatorNames.length > 0) {
    markdown += `<details>\n<summary>Detailed Results</summary>\n\n`;
    markdown += `| Evaluator | ${jobNames.join(" | ")} |\n`;
    markdown += `|-----------|${jobNames.map(() => "-------").join("|")}|\n`;

    evaluatorNames.forEach((evaluatorName) => {
      const row = [evaluatorName];
      jobNames.forEach((jobName) => {
        const avgData = averages.get(evaluatorName)?.get(jobName);
        row.push(avgData?.value || "-");
      });
      markdown += `| ${row.join(" | ")} |\n`;
    });

    markdown += `\n</details>\n\n`;
  }

  // Errors
  const errors = collectErrors(results);
  if (errors.length > 0) {
    markdown += `<details>\n<summary>Errors (${errors.length})</summary>\n\n`;
    markdown += "```\n";
    errors.forEach((error) => {
      markdown += `${error}\n`;
    });
    markdown += "```\n\n</details>\n\n";
  }

  markdown += `---\n\n`;

  try {
    fs.appendFileSync(summaryPath, markdown);
  } catch {
    // Silently fail if we can't write to the summary file
  }
}

export const displayResultsTableEffect = (
  results: EvaluatorqResult,
  evaluationName?: string,
): Effect.Effect<void, never, never> =>
  Effect.sync(() => {
    if (results.length === 0) {
      console.log(chalk.yellow("\nNo results to display.\n"));
      return;
    }

    // Write to GitHub step summary if in CI
    if (evaluationName) {
      writeGitHubStepSummary(evaluationName, results);
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

    // Show errors if any
    const errors = collectErrors(results);
    if (errors.length > 0) {
      console.log(chalk.bold.red("Errors:"));
      errors.forEach((error) => {
        console.log(chalk.red(error));
      });
      console.log("");
    }

    // Show tip
    console.log(chalk.dim("💡 Tip: Use print:false to get raw JSON results."));
    console.log("");
  });
