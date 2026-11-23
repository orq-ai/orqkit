import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import type { Span } from "@opentelemetry/api";

interface ThreadStore {
  threadId?: string;
  pipeline?: string;
  runId?: string;
  warnedKeys?: Set<string | number>;
}

const storage = new AsyncLocalStorage<ThreadStore>();

function current(): ThreadStore {
  return storage.getStore() ?? {};
}

function bind<T>(patch: ThreadStore, fn: () => T): T {
  return storage.run({ ...current(), ...patch }, fn);
}

const THREAD_ID_SEP = ":";

export function warnOnce(
  keys: readonly (string | number)[],
  message: string,
): void {
  const seen = current().warnedKeys;
  const fresh = !seen || keys.some((key) => !seen.has(key));
  for (const key of keys) {
    seen?.add(key);
  }
  (fresh ? console.warn : console.error)(message);
}

export function buildThreadId(
  runId: string | null | undefined,
  ...parts: unknown[]
): string | null {
  return runId ? [runId, ...parts.map(String)].join(THREAD_ID_SEP) : null;
}

export function buildStaticThreadId(
  runId: string | null | undefined,
  targetId: string,
  row: number,
): string {
  return buildThreadId(runId || `static-${targetId}`, targetId, row) as string;
}

export function currentThreadId(): string | null {
  return current().threadId ?? null;
}

export function threadBodyParam(): { thread?: { id: string } } {
  const id = current().threadId;
  return id ? { thread: { id } } : {};
}

export function pipelineMetadata(): Record<string, string> {
  const { pipeline, runId } = current();
  return {
    ...(pipeline ? { evaluatorq_pipeline: pipeline } : {}),
    ...(runId ? { evaluatorq_run_id: runId } : {}),
  };
}

export function pipelineMetadataParam(): {
  metadata?: Record<string, string>;
} {
  const metadata = pipelineMetadata();
  return Object.keys(metadata).length > 0 ? { metadata } : {};
}

export function evaluatorqPipeline<T>(label: string, fn: () => T): T {
  return bind({ pipeline: label }, fn);
}

export function evaluatorqRunId<T>(runId: string, fn: () => T): T {
  return bind({ runId }, fn);
}

export function evaluatorqRunScope<T>(
  runId: string,
  span: Span | undefined,
  fn: () => T,
): T {
  span?.setAttribute("orq.evaluatorq_run_id", runId);
  return evaluatorqRunId(runId, fn);
}

export function conversationThread<T>(
  threadId: string | null | undefined,
  fn: (threadId: string) => T,
): T {
  const id = threadId || randomUUID();
  return bind({ threadId: id, warnedKeys: new Set() }, () => fn(id));
}
