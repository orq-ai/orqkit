import { AsyncLocalStorage } from "node:async_hooks";

import type { MaybeAsync } from "../../common/async-utils.js";
export interface AttackProgress {
  startAttack(label: string, totalTurns: number): MaybeAsync<number | null>;
  updateAttack(taskId: number | null, completed: number): MaybeAsync<void>;
  finishAttack(taskId: number | null): MaybeAsync<void>;
}
const active = new AsyncLocalStorage<AttackProgress>();
export function getActiveProgress(): AttackProgress | null {
  return active.getStore() ?? null;
}
export function withAttackProgress<T>(
  progress: AttackProgress,
  fn: () => T,
): T {
  return active.run(progress, fn);
}
