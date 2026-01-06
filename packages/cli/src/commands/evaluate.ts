import fs from "node:fs";
import path from "node:path";

import { execa } from "execa";
import { glob } from "glob";

interface EvaluateOptions {
  watch?: boolean;
}

interface EvalResult {
  file: string;
  passed: boolean;
  duration: number;
  error?: string;
}

function writeGitHubSummary(results: EvalResult[]) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const total = results.length;

  const statusEmoji = failed > 0 ? "❌" : "✅";
  const statusText = failed > 0 ? "Some tests failed" : "All tests passed";

  let markdown = `## ${statusEmoji} Evaluation Results\n\n`;
  markdown += `**${statusText}** - ${passed}/${total} passed\n\n`;
  markdown += `| File | Status | Duration |\n`;
  markdown += `|------|--------|----------|\n`;

  for (const result of results) {
    const status = result.passed ? "✅ Passed" : "❌ Failed";
    const duration = `${(result.duration / 1000).toFixed(2)}s`;
    markdown += `| ${result.file} | ${status} | ${duration} |\n`;
  }

  if (failed > 0) {
    markdown += `\n### Errors\n\n`;
    for (const result of results.filter((r) => !r.passed && r.error)) {
      markdown += `**${result.file}:**\n\`\`\`\n${result.error}\n\`\`\`\n\n`;
    }
  }

  fs.appendFileSync(summaryPath, markdown);
}

export async function evaluate(pattern: string, _options: EvaluateOptions) {
  // Simply run with inherited stdio - let evaluatorq handle its own output
  const matches = await glob(pattern, {
    absolute: true,
    ignore: ["**/node_modules/**", "**/dist/**"],
  });

  const evalFiles = matches.filter((file) => file.endsWith(".eval.ts"));

  if (evalFiles.length === 0) {
    console.log(`No evaluation files found matching pattern: ${pattern}`);
    console.log("Make sure your files end with .eval.ts");
    return;
  }

  console.log("Running evaluations:\n");

  const results: EvalResult[] = [];

  for (const file of evalFiles) {
    const fileName = path.basename(file);
    console.log(`⚡ Running ${fileName}...`);

    const startTime = Date.now();

    try {
      await execa("tsx", [file], {
        preferLocal: true,
        cwd: process.cwd(),
        stdio: "inherit",
      });
      console.log(`✅ ${fileName} completed\n`);
      results.push({
        file: fileName,
        passed: true,
        duration: Date.now() - startTime,
      });
    } catch (error) {
      console.error(`❌ ${fileName} failed`);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(`   Error: ${errorMessage}\n`);
      results.push({
        file: fileName,
        passed: false,
        duration: Date.now() - startTime,
        error: errorMessage,
      });
    }
  }

  // Write GitHub Actions summary if running in CI
  writeGitHubSummary(results);

  const hasFailures = results.some((r) => !r.passed);
  if (hasFailures) {
    process.exit(1);
  }
}
