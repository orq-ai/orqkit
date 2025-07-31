import type { EvaluatorqResult } from "../evaluatorq.ts";
import type { TableRow, VisualizerOptions } from "./types.ts";

export function generateHTML(
  evaluationName: string,
  results: EvaluatorqResult,
  options: VisualizerOptions = {},
): string {
  const {
    title = `Evaluation Results: ${evaluationName}`,
    description = "",
    showTimestamp = true,
  } = options;

  const tableRows = flattenResultsToRows(results);
  const evaluatorNames = extractEvaluatorNames(results);

  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)}</title>
    <style>
        ${getCSS()}
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>${escapeHtml(title)}</h1>
            ${description ? `<p class="description">${escapeHtml(description)}</p>` : ""}
            ${showTimestamp ? `<p class="timestamp">Generated: ${new Date().toLocaleString()}</p>` : ""}
        </header>
        
        <div class="summary">
            <h2>Summary</h2>
            <div class="summary-grid">
                <div class="summary-item">
                    <div class="summary-label">Total Data Points</div>
                    <div class="summary-value">${results.length}</div>
                </div>
                <div class="summary-item">
                    <div class="summary-label">Total Jobs Run</div>
                    <div class="summary-value">${tableRows.length}</div>
                </div>
                <div class="summary-item">
                    <div class="summary-label">Failed Data Points</div>
                    <div class="summary-value">${results.filter((r) => r.error).length}</div>
                </div>
                <div class="summary-item">
                    <div class="summary-label">Failed Jobs</div>
                    <div class="summary-value">${tableRows.filter((r) => r.jobError).length}</div>
                </div>
            </div>
        </div>

        <div class="results-table">
            <h2>Detailed Results</h2>
            <div class="table-wrapper">
                <table>
                    <thead>
                        <tr>
                            <th>Data Point</th>
                            <th>Inputs</th>
                            <th>Expected Output</th>
                            <th>Job</th>
                            <th>Output</th>
                            ${evaluatorNames.map((name) => `<th>${escapeHtml(name)}</th>`).join("")}
                        </tr>
                    </thead>
                    <tbody>
                        ${tableRows.map((row) => generateTableRow(row, evaluatorNames)).join("")}
                    </tbody>
                </table>
            </div>
        </div>
    </div>
</body>
</html>
  `;
}

function flattenResultsToRows(results: EvaluatorqResult): TableRow[] {
  const rows: TableRow[] = [];

  results.forEach((result, dataPointIndex) => {
    if (result.error) {
      rows.push({
        dataPointIndex: dataPointIndex + 1,
        inputs: JSON.stringify(result.dataPoint.inputs, null, 2),
        expectedOutput: String(result.dataPoint.expectedOutput ?? "N/A"),
        jobName: "N/A",
        jobOutput: "N/A",
        jobError: result.error.message,
        evaluatorScores: {},
      });
    } else if (result.jobResults) {
      result.jobResults.forEach((jobResult) => {
        const evaluatorScores: Record<string, string> = {};

        if (jobResult.evaluatorScores) {
          jobResult.evaluatorScores.forEach((score) => {
            if (score.error) {
              evaluatorScores[score.evaluatorName] =
                `Error: ${score.error.message}`;
            } else {
              evaluatorScores[score.evaluatorName] = String(score.score);
            }
          });
        }

        rows.push({
          dataPointIndex: dataPointIndex + 1,
          inputs: JSON.stringify(result.dataPoint.inputs, null, 2),
          expectedOutput: String(result.dataPoint.expectedOutput ?? "N/A"),
          jobName: jobResult.jobName,
          jobOutput: jobResult.error ? "N/A" : JSON.stringify(jobResult.output),
          jobError: jobResult.error?.message,
          evaluatorScores,
        });
      });
    }
  });

  return rows;
}

function extractEvaluatorNames(results: EvaluatorqResult): string[] {
  const names = new Set<string>();

  results.forEach((result) => {
    result.jobResults?.forEach((jobResult) => {
      jobResult.evaluatorScores?.forEach((score) => {
        names.add(score.evaluatorName);
      });
    });
  });

  return Array.from(names).sort();
}

function generateTableRow(row: TableRow, evaluatorNames: string[]): string {
  const rowClass = row.jobError ? "error-row" : "";

  return `
    <tr class="${rowClass}">
        <td>${row.dataPointIndex}</td>
        <td><pre>${escapeHtml(row.inputs)}</pre></td>
        <td>${escapeHtml(row.expectedOutput)}</td>
        <td>${escapeHtml(row.jobName)}</td>
        <td class="${row.jobError ? "error-cell" : ""}">
            ${row.jobError ? escapeHtml(row.jobError) : escapeHtml(row.jobOutput)}
        </td>
        ${evaluatorNames
          .map((name) => {
            const score = row.evaluatorScores[name] ?? "N/A";
            const isError = score.startsWith("Error:");
            const cellClass = isError ? "error-cell" : getScoreCellClass(score);
            return `<td class="${cellClass}">${escapeHtml(score)}</td>`;
          })
          .join("")}
    </tr>
  `;
}

function getScoreCellClass(score: string): string {
  if (score === "true" || score === "1") return "success-cell";
  if (score === "false" || score === "0") return "failure-cell";
  if (!Number.isNaN(parseFloat(score))) {
    const num = parseFloat(score);
    if (num >= 0.8) return "success-cell";
    if (num >= 0.5) return "warning-cell";
    return "failure-cell";
  }
  return "";
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function getCSS(): string {
  return `
    * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
    }

    body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
        line-height: 1.6;
        color: #333;
        background-color: #f5f5f5;
    }

    .container {
        max-width: 1400px;
        margin: 0 auto;
        padding: 20px;
    }

    header {
        background-color: white;
        padding: 30px;
        border-radius: 8px;
        box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        margin-bottom: 30px;
    }

    h1 {
        color: #2c3e50;
        margin-bottom: 10px;
    }

    h2 {
        color: #34495e;
        margin-bottom: 20px;
        font-size: 1.5rem;
    }

    .description {
        color: #666;
        font-size: 1.1rem;
    }

    .timestamp {
        color: #999;
        font-size: 0.9rem;
        margin-top: 10px;
    }

    .summary {
        background-color: white;
        padding: 30px;
        border-radius: 8px;
        box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        margin-bottom: 30px;
    }

    .summary-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        gap: 20px;
    }

    .summary-item {
        text-align: center;
        padding: 20px;
        background-color: #f8f9fa;
        border-radius: 8px;
    }

    .summary-label {
        font-size: 0.9rem;
        color: #666;
        margin-bottom: 5px;
    }

    .summary-value {
        font-size: 2rem;
        font-weight: bold;
        color: #2c3e50;
    }

    .results-table {
        background-color: white;
        padding: 30px;
        border-radius: 8px;
        box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }

    .table-wrapper {
        overflow-x: auto;
    }

    table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.9rem;
    }

    th {
        background-color: #2c3e50;
        color: white;
        padding: 12px;
        text-align: left;
        position: sticky;
        top: 0;
        z-index: 10;
    }

    td {
        padding: 12px;
        border-bottom: 1px solid #e0e0e0;
    }

    tr:hover {
        background-color: #f8f9fa;
    }

    pre {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        font-size: 0.85rem;
        max-width: 300px;
    }

    .error-row {
        background-color: #ffebee;
    }

    .error-cell {
        color: #c62828;
        font-weight: 500;
    }

    .success-cell {
        color: #2e7d32;
        font-weight: 500;
    }

    .failure-cell {
        color: #d32f2f;
        font-weight: 500;
    }

    .warning-cell {
        color: #f57c00;
        font-weight: 500;
    }

    @media (max-width: 768px) {
        .container {
            padding: 10px;
        }

        header, .summary, .results-table {
            padding: 20px;
        }

        table {
            font-size: 0.8rem;
        }

        th, td {
            padding: 8px;
        }
    }
  `;
}
