import { AsyncLocalStorage } from "node:async_hooks";

import { envRaw } from "../common/env-config.js";

const debug = new AsyncLocalStorage<boolean>();
export function enabled(): boolean {
  return (
    Boolean(debug.getStore()) ||
    envRaw("EVALUATORQ_LOG_LEVEL", "").toUpperCase() === "DEBUG"
  );
}
export function cliDebug<T>(options: { active: boolean }, fn: () => T): T {
  return debug.run(options.active, fn);
}
