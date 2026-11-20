import {
  type DashboardArguments,
  executeDashboard,
} from "@orq-ai/evaluatorq/dashboard";

export async function runDashboard(
  paths: string[],
  options: Omit<DashboardArguments, "paths"> & { browser?: boolean },
): Promise<void> {
  try {
    const { browser, ...rest } = options;
    const code = await executeDashboard(
      { ...rest, paths, noBrowser: browser === false },
      { print: (message: string) => console.log(message) },
    );
    if (code) process.exitCode = code;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
