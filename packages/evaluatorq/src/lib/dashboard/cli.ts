import { statSync } from "node:fs";
import { dirname, join } from "node:path";

import { reportId } from "../common/dashboard/library.js";
import {
  addCliModels,
  exportCliModels,
  parseOverrides,
} from "../common/model-roles.js";
import { serve } from "./launch.js";
import { FinderState } from "./trace-finder/routes.js";

export const DASHBOARD_HELP = `Launch the dashboard (preview \u2014 still in development).

With no PATH the red-team (.evaluatorq/runs/), simulation
(.evaluatorq/sim-runs/) and pairwise (.evaluatorq/pairwise-runs/)
run stores are scanned.

With one or more directory PATHs those directories are scanned together \u2014
e.g. sim runs from one repo next to red team runs from another.

With a file PATH the file's parent directory is scanned so the report
resolves.  The direct URL for that report is printed so you can open it
immediately instead of landing on the index listing.`;

export interface DashboardArguments {
  paths?: string[];
  host?: string;
  port?: number;
  noBrowser?: boolean;
  compilerModel?: string;
  classifierModel?: string;
  windowDays?: number;
  limit?: number;
  parallelism?: number;
}

export interface DashboardIO {
  print: (message: string) => void;
  serve?: typeof serve;
  createFinder?: () => Promise<FinderState>;
}

const BOUNDS: [keyof DashboardArguments, string, number, number, string][] = [
  ["windowDays", "--window-days", 1, 90, "EVALUATORQ_FINDER_WINDOW_DAYS"],
  ["limit", "--limit", 1, 5000, "EVALUATORQ_FINDER_LIMIT"],
  ["parallelism", "--parallelism", 1, 200, "EVALUATORQ_FINDER_PARALLELISM"],
];

const STORES = [
  "",
  "runs",
  "sim-runs",
  "pairwise-runs",
  join(".evaluatorq", "runs"),
  join(".evaluatorq", "sim-runs"),
  join(".evaluatorq", "pairwise-runs"),
];

export function dashboardRoots(paths: readonly string[]): {
  roots: string[] | null;
  directRids: string[];
} {
  if (paths.length === 0) return { roots: null, directRids: [] };
  const roots: string[] = [];
  const directRids: string[] = [];
  for (const path of paths) {
    const info = statSync(path, { throwIfNoEntry: false });
    if (info?.isDirectory()) {
      for (const store of STORES) roots.push(store ? join(path, store) : path);
    } else if (info?.isFile()) {
      roots.push(dirname(path));
      directRids.push(reportId(path));
    } else {
      throw new Error(`Path does not exist: ${path}`);
    }
  }
  return { roots, directRids };
}

export async function executeDashboard(
  args: DashboardArguments,
  io: DashboardIO,
): Promise<number> {
  for (const [key, flag, min, max] of BOUNDS) {
    const value = args[key] as number | undefined;
    if (
      value !== undefined &&
      (!Number.isInteger(value) || value < min || value > max)
    ) {
      throw new Error(
        `Invalid value for '${flag}': ${value} is not in the range ${min}<=x<=${max}.`,
      );
    }
  }
  const host = args.host ?? "127.0.0.1";
  const port = args.port ?? 8080;
  const { roots, directRids } = dashboardRoots(args.paths ?? []);
  addCliModels(
    { classifier: args.classifierModel },
    args.compilerModel
      ? parseOverrides([`finder.compiler=${args.compilerModel}`])
      : null,
  );
  exportCliModels();
  for (const [key, , , , env] of BOUNDS) {
    const value = args[key];
    if (value !== undefined) process.env[env] = String(value);
  }
  for (const rid of directRids) {
    io.print(`Direct report URL: http://${host}:${port}/r/${rid}`);
  }
  const finder = await (io.createFinder ?? (() => FinderState.create()))();
  await (io.serve ?? serve)(roots, {
    host,
    port,
    openBrowser: !args.noBrowser,
    finder,
  });
  return 0;
}
