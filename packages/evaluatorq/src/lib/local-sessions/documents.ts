import { TraceDocument } from "../common/trace-document.js";
import { ResponsesConversation } from "../formats/responses.js";
import type { ParsedSession } from "./models.js";

export function sessionDocument(parsed: ParsedSession): TraceDocument {
  const { summary } = parsed;
  const trajectory = new ResponsesConversation({ items: parsed.items }).toAtif({
    agentName: summary.source,
    agentVersion: summary.agentVersion || "unknown",
    sessionId: summary.sessionId,
  });
  const toolNames = [
    ...new Set(
      parsed.items.flatMap((item) =>
        item.type === "function_call" && typeof item.name === "string"
          ? [item.name]
          : [],
      ),
    ),
  ].sort();
  return new TraceDocument({
    metadata: {
      traceId: `${summary.source}:${summary.sessionId}`,
      spanId: summary.sessionId,
      timestamp: summary.startedAt,
      project: summary.projectDir,
      model: parsed.model,
      product: "local-session",
      traceType: "agent-session",
      agentName: summary.source,
      toolNames,
      totalTokens: parsed.totalTokens,
      durationMs: Math.max(
        0,
        summary.updatedAt.getTime() - summary.startedAt.getTime(),
      ),
      captureMetadata: {
        source: `local:${summary.source}`,
        start: summary.startedAt.toISOString(),
        end: summary.updatedAt.toISOString(),
      },
    },
    trajectory,
  });
}
