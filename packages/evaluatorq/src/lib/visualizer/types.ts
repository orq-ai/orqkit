export interface VisualizerOptions {
  title?: string;
  description?: string;
  showTimestamp?: boolean;
  outputPath?: string;
  autoOpen?: boolean;
}

export interface TableRow {
  dataPointIndex: number;
  inputs: string;
  expectedOutput: string;
  jobName: string;
  jobOutput: string;
  jobError?: string;
  evaluatorScores: Record<string, string>;
}
