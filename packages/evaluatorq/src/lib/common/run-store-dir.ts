import { join } from "node:path";

export const STORE_DIR_NAME = ".evaluatorq";

export function getStoreDir(subdir: string): string {
  const base = process.env.EVALUATORQ_DIR;
  return join(base ? base : join(process.cwd(), STORE_DIR_NAME), subdir);
}
