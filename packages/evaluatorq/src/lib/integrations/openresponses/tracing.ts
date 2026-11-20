import type { Span } from "@opentelemetry/api";

import { getField } from "../../common/fields.js";
import { jsonWithFallback } from "../../common/messages.js";
import {
  captureMessageContent,
  type LlmSpanOptions,
  recordLlmResponse,
  truncateForSpan,
  withLlmSpan,
} from "../../common/tracing.js";
import {
  itemsToInputMessages,
  itemsToOutputMessages,
} from "./otel-messages.js";

export function withOpenResponsesSpan<T>(
  options: LlmSpanOptions & { purpose?: string },
  fn: (span: Span | undefined) => Promise<T>,
): Promise<T> {
  const { purpose, ...base } = options;
  return withLlmSpan(
    {
      ...base,
      attributes: {
        ...base.attributes,
        ...(purpose
          ? {
              "orq.llm.purpose": purpose,
              "orq.simulation.llm_purpose": purpose,
            }
          : {}),
      },
    },
    fn,
  );
}
export function recordOpenResponsesRequest(
  span: Span | undefined,
  payload: Readonly<Record<string, unknown>>,
): void {
  if (!span) return;
  if (payload.model)
    span.setAttribute("gen_ai.request.model", String(payload.model));
  if (
    typeof payload.max_output_tokens === "number" &&
    Number.isInteger(payload.max_output_tokens)
  )
    span.setAttribute("gen_ai.request.max_tokens", payload.max_output_tokens);
  const effort = getField(payload.reasoning, "effort");
  if (effort)
    span.setAttribute("gen_ai.request.reasoning_effort", String(effort));
  if (!captureMessageContent()) return;
  const input = payload.input || [];
  const messages = truncateForSpan(
    jsonWithFallback(itemsToInputMessages(input)),
  );
  span.setAttribute("gen_ai.input.messages", messages);
  span.setAttribute("input", messages);
  span.setAttribute(
    "openresponses.input",
    truncateForSpan(jsonWithFallback(input)),
  );
  if (payload.instructions) {
    const instructions = truncateForSpan(payload.instructions);
    span.setAttribute("gen_ai.system_instructions", instructions);
    span.setAttribute("openresponses.instructions", instructions);
  }
  span.setAttribute(
    "orq.openresponses.request",
    truncateForSpan(jsonWithFallback(payload)),
  );
}
export function recordOpenResponsesResponse(
  span: Span | undefined,
  response: unknown,
): void {
  if (!span) return;
  recordLlmResponse(span, response);
  if (!captureMessageContent()) return;
  span.setAttribute(
    "orq.openresponses.response",
    truncateForSpan(jsonWithFallback(response)),
  );
  const output = getField(response, "output");
  if (output !== undefined && output !== null) {
    span.setAttribute(
      "openresponses.output",
      truncateForSpan(jsonWithFallback(output)),
    );
    const serialized = truncateForSpan(
      jsonWithFallback(
        itemsToOutputMessages(
          output,
          String(getField(response, "status") || ""),
        ),
      ),
    );
    span.setAttribute("gen_ai.output.messages", serialized);
    span.setAttribute("output", serialized);
  }
}
