import { AsyncLocalStorage } from "node:async_hooks";
export type LoadReporter = (done: number, total: number) => void;
const reporter = new AsyncLocalStorage<LoadReporter | null>();
export function reportLoadProgress(done: number, total: number): void {
  reporter.getStore()?.(done, total);
}
export function setLoadReporter(callback: LoadReporter | null): void {
  reporter.enterWith(callback);
}

export function withLoadReporter<T>(callback: LoadReporter, work: () => T): T {
  return reporter.run(callback, work);
}
