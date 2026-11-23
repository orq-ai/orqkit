import type { Span } from "@opentelemetry/api";

import {
  type AttrMap,
  type LlmSpanOptions,
  setSpanAttrs,
  withLlmSpan as withCommonLlmSpan,
  withSpan,
} from "../common/tracing.js";
import type { JuryResult } from "../contracts.js";

export function withRedteamSpan<T>(
  name: string,
  attributes: AttrMap,
  fn: (span: Span | undefined) => Promise<T>,
  parentContext?: unknown,
): Promise<T> {
  return withSpan(name, { attributes, parentContext }, fn);
}
export function withRedteamLlmSpan<T>(
  options: LlmSpanOptions,
  fn: (span: Span | undefined) => Promise<T>,
): Promise<T> {
  const attributes = { ...options.attributes };
  const purpose = attributes["orq.redteam.llm_purpose"];
  if (purpose != null && !("orq.llm.purpose" in attributes))
    attributes["orq.llm.purpose"] = purpose;
  return withCommonLlmSpan({ ...options, attributes }, fn);
}
export async function annotateCurrentSpan<T>(
  attributes: AttrMap,
  fn: (span: Span | undefined) => Promise<T>,
): Promise<T> {
  let span: Span | undefined;
  try {
    const { trace } = await import("@opentelemetry/api");
    span = trace.getActiveSpan();
  } catch {}
  setSpanAttrs(span, attributes);
  return fn(span);
}
export function setJurySpanAttrs(
  span: Span | undefined,
  jury: JuryResult | null | undefined,
): void {
  if (!span || !jury) return;
  const data = {
    judges_configured: jury.judgesConfigured,
    judges_succeeded: jury.judgesSucceeded,
    judges_failed: jury.judgesFailed,
    replacements_used: jury.replacementsUsed,
    raw_agreement: jury.rawAgreement,
    tie: jury.tie,
    inconclusive: jury.inconclusive,
  };
  const attributes: AttrMap = Object.fromEntries(
    Object.entries(data).map(([key, value]) => [
      `orq.redteam.jury.${key}`,
      value,
    ]),
  );
  attributes.metadata = JSON.stringify({ jury: data });
  setSpanAttrs(span, attributes);
}
