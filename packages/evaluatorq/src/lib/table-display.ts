import { Effect } from "effect";
import chalk from "chalk";
import stripAnsi from "strip-ansi";
import type { EvaluatorScore, EvaluatorqResult } from "./types.js";

// Get actual string length without ANSI codes
function getStringLength(str: string): number {
	return stripAnsi(str).length;
}

// Truncate string to fit within maxWidth (accounting for ANSI codes)
function truncate(str: string, maxWidth: number): string {
	const plainStr = stripAnsi(str);
	if (plainStr.length <= maxWidth) return str;
	
	// For strings with ANSI codes, we need to be more careful
	if (str !== plainStr) {
		// Simple approach: just use plain string and re-apply basic coloring if needed
		return plainStr.substring(0, maxWidth - 3) + "...";
	}
	
	return str.substring(0, maxWidth - 3) + "...";
}

// Pad string to width (accounting for ANSI codes)
function pad(str: string, width: number, align: "left" | "right" = "left"): string {
	const actualLength = getStringLength(str);
	const padding = Math.max(0, width - actualLength);
	
	if (align === "left") {
		return str + " ".repeat(padding);
	} else {
		return " ".repeat(padding) + str;
	}
}

// Format value with smart truncation
function formatValue(value: unknown, maxWidth: number = 30): string {
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

// Extract key-value pairs from object for compact display
function extractObjectInfo(obj: unknown): string {
	if (typeof obj !== "object" || obj === null) return formatValue(obj);
	
	const entries = Object.entries(obj);
	if (entries.length === 0) return "{}";
	
	// For simple objects, show key: value pairs
	return entries
		.map(([key, value]) => {
			const formattedValue = typeof value === "string" 
				? value 
				: JSON.stringify(value);
			return `${key}: ${formattedValue}`;
		})
		.join(", ");
}

// Format evaluator scores for compact display
function formatEvaluatorScoresCompact(scores?: EvaluatorScore[]): string[] {
	if (!scores || scores.length === 0) return ["-"];

	return scores.map((score) => {
		const name = chalk.cyan(score.evaluatorName);
		if (score.error) {
			return `${name}: ${chalk.red("ERROR")}`;
		}
		const scoreValue = typeof score.score === "boolean" 
			? (score.score ? chalk.green("✓") : chalk.red("✗"))
			: typeof score.score === "number"
				? chalk.yellow(score.score.toFixed(2))
				: chalk.gray(String(score.score));
		return `${name}: ${scoreValue}`;
	});
}

// Simple table renderer with multi-line support
function renderDetailedTable(headers: string[], rows: Array<{main: string[], details?: string[]}>, colWidths: number[]): string {
	const lines: string[] = [];
	
	// Calculate total width for detail rows
	// Total width = sum of column widths + (number of columns - 1) * 3 (for " │ " separators) + 4 (for "│ " and " │")
	const totalContentWidth = colWidths.reduce((sum, w) => sum + w, 0) + (colWidths.length - 1) * 3;
	
	// Top border
	const topBorder = "┌" + colWidths.map(w => "─".repeat(w + 2)).join("┬") + "┐";
	lines.push(topBorder);
	
	// Headers
	const headerRow = "│ " + headers.map((h, i) => pad(h, colWidths[i])).join(" │ ") + " │";
	lines.push(headerRow);
	
	// Header separator
	const headerSep = "├" + colWidths.map(w => "─".repeat(w + 2)).join("┼") + "┤";
	lines.push(headerSep);
	
	// Data rows with details
	rows.forEach((row, rowIndex) => {
		// Main row
		const mainRow = "│ " + row.main.map((cell, i) => pad(truncate(cell, colWidths[i]), colWidths[i])).join(" │ ") + " │";
		lines.push(mainRow);
		
		// Detail rows (if any) - these span all columns
		if (row.details && row.details.length > 0) {
			row.details.forEach(detail => {
				const detailContent = chalk.dim("  └─ " + detail);
				const paddedDetail = pad(detailContent, totalContentWidth);
				const detailRow = "│ " + paddedDetail + " │";
				lines.push(detailRow);
			});
		}
		
		// Add separator between data point groups (but not after the last one)
		if (rowIndex < rows.length - 1) {
			// Check if next row starts a new data point
			const nextRow = rows[rowIndex + 1];
			if (nextRow.main[0] && nextRow.main[0].includes("#")) {
				const rowSep = "├" + colWidths.map(w => "─".repeat(w + 2)).join("┼") + "┤";
				lines.push(rowSep);
			}
		}
	});
	
	// Bottom border
	const bottomBorder = "└" + colWidths.map(w => "─".repeat(w + 2)).join("┴") + "┘";
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

	const successRate = totalJobs > 0 ? Math.round(((totalJobs - failedJobs) / totalJobs) * 100) : 0;

	const headers = ["Metric", "Value"];
	const rows = [
		{ main: ["Total Data Points", chalk.cyan(String(totalDataPoints))] },
		{ main: ["Failed Data Points", failedDataPoints > 0 ? chalk.red(String(failedDataPoints)) : chalk.green("0")] },
		{ main: ["Total Jobs", chalk.cyan(String(totalJobs))] },
		{ main: ["Failed Jobs", failedJobs > 0 ? chalk.red(String(failedJobs)) : chalk.green("0")] },
		{ main: ["Success Rate", failedJobs === 0 ? chalk.green("100%") : successRate >= 80 ? chalk.green(`${successRate}%`) : successRate >= 50 ? chalk.yellow(`${successRate}%`) : chalk.red(`${successRate}%`)] },
	];
	
	return renderDetailedTable(headers, rows, [20, 15]);
}

// Create the main results display with details
function createResultsDisplay(results: EvaluatorqResult): string {
	// Calculate column widths
	const minWidths = {
		id: 6,
		job: 12,
		output: 20,
		data: 25,
	};
	
	// Headers without evaluators column - we'll show them in details
	const headers = ["ID", "Inputs", "Expected", "Job", "Output"];
	const colWidths = [minWidths.id, minWidths.data, minWidths.data, minWidths.job, minWidths.output];

	const rows: Array<{main: string[], details?: string[]}> = [];

	// Add rows with details
	results.forEach((result, dataPointIndex) => {
		if (result.error) {
			rows.push({
				main: [
					chalk.red(`#${dataPointIndex}`),
					extractObjectInfo(result.dataPoint.inputs),
					formatValue(result.dataPoint.expectedOutput),
					chalk.red("ERROR"),
					chalk.red("Failed"),
				],
				details: [chalk.red(`Error: ${result.error.message}`)],
			});
		} else if (result.jobResults) {
			result.jobResults.forEach((jobResult, jobIndex) => {
				const inputsStr = jobIndex === 0 ? extractObjectInfo(result.dataPoint.inputs) : "";
				const expectedStr = jobIndex === 0 ? formatValue(result.dataPoint.expectedOutput) : "";
				
				const details: string[] = [];
				
				// Add full output if it's complex or truncated
				const outputStr = formatValue(jobResult.output);
				if (outputStr.length > minWidths.output || typeof jobResult.output === "object") {
					details.push(`Output: ${outputStr}`);
				}
				
				// Add evaluator scores as details
				if (jobResult.evaluatorScores && jobResult.evaluatorScores.length > 0) {
					const scores = formatEvaluatorScoresCompact(jobResult.evaluatorScores);
					details.push(`Scores: ${scores.join(", ")}`);
				}
				
				// Add error details if any
				if (jobResult.error) {
					details.push(chalk.red(`Error: ${jobResult.error.message}`));
				}
				
				rows.push({
					main: [
						jobIndex === 0 ? chalk.blue(`#${dataPointIndex}`) : "",
						inputsStr,
						expectedStr,
						jobResult.error
							? chalk.red(jobResult.jobName)
							: chalk.green(jobResult.jobName),
						jobResult.error
							? chalk.red("Error")
							: truncate(outputStr, minWidths.output),
					],
					details: details.length > 0 ? details : undefined,
				});
			});
		}
	});

	return renderDetailedTable(headers, rows, colWidths);
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