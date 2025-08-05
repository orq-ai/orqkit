import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { platform } from "node:os";
import { resolve } from "node:path";

import type { EvaluatorqResult } from "../types.js";
import { generateHTML } from "./html-generator.js";
import type { VisualizerOptions } from "./types.js";

export { generateHTML } from "./html-generator.js";
export type { TableRow, VisualizerOptions } from "./types.js";

/**
 * Visualizes evaluation results by generating an HTML report
 * @param evaluationName - Name of the evaluation run
 * @param results - The evaluation results to visualize
 * @param options - Visualization options
 * @returns The path to the generated HTML file
 */
export async function visualizeResults(
  evaluationName: string,
  results: EvaluatorqResult,
  options: VisualizerOptions = {},
): Promise<string> {
  const {
    outputPath = `./evaluation-report-${Date.now()}.html`,
    autoOpen = true,
    ...htmlOptions
  } = options;

  const html = generateHTML(evaluationName, results, htmlOptions);
  const absolutePath = resolve(outputPath);

  // Write the HTML file
  writeFileSync(absolutePath, html, "utf-8");
  console.log(`Report generated: ${absolutePath}`);

  // Open in browser if requested
  if (autoOpen) {
    openInBrowser(absolutePath);
  }

  return absolutePath;
}

/**
 * Opens a file in the default browser
 * @param filePath - Path to the file to open
 */
function openInBrowser(filePath: string): void {
  const commands: Record<string, string> = {
    darwin: "open",
    win32: "start",
    linux: "xdg-open",
  };

  const command = commands[platform()];

  if (!command) {
    console.warn("Unable to determine platform for opening browser");
    return;
  }

  try {
    execSync(`${command} "${filePath}"`, { stdio: "ignore" });
    console.log("Report opened in browser");
  } catch (error) {
    console.warn("Failed to open report in browser:", error);
  }
}
