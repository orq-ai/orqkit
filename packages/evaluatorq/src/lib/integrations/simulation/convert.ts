import { jsonWithFallback, wireArguments } from "../../common/messages.js";
import {
  RESPONSES_ASSISTANT_TURN_ORDER_KEY,
  RESPONSES_ITEM_ORDER_KEY,
} from "../../common/output-adapters.js";
import { responsesFunctionCallItemId } from "../openresponses/input-items.js";

/**
 * Conversion functions from SimulationResult to OpenResponses format.
 */

import { generateItemId } from "../common/utils.js";
import type {
  ItemField,
  Message,
  ResponseResource,
  Usage,
} from "../openresponses/index.js";
import type { SimulationResult } from "./types.js";

/**
 * Converts a SimulationResult to OpenResponses format.
 *
 * Mapping:
 * - messages with role "user"      → input[] as Message with input_text content
 * - messages with role "assistant"  → output[] as Message with output_text content
 * - messages with role "system"     → input[] as Message with input_text content
 * - token_usage                     → Usage
 * - terminated_by                   → status ("judge" → "completed", others → "incomplete")
 * - goal_achieved, rules_broken, criteria_results, turn_metrics → metadata
 *
 * @param result - The simulation result to convert
 * @param model - Optional model name to include in the response
 * @returns A ResponseResource in OpenResponses format
 */
export function toOpenResponses(
  result: SimulationResult,
  model = "simulation",
): ResponseResource {
  const now = Math.floor(Date.now() / 1000);

  const inputItems: ItemField[] = [];
  const outputItems: ItemField[] = [];
  const itemOrder: ("input" | "output")[] = [];
  const assistantTurnOrder: (number | null)[] = [];

  for (const [messageIndex, msg] of result.messages.entries()) {
    if (msg.role === "user" || msg.role === "system") {
      const inputMessage: Message = {
        type: "message",
        id: generateItemId("msg"),
        role: msg.role,
        status: "completed",
        content: [{ type: "input_text", text: msg.content }],
      };
      inputItems.push(inputMessage);
      itemOrder.push("input");
    } else if (msg.role === "assistant") {
      if (msg.content || !msg.tool_calls?.length) {
        const outputMessage: Message = {
          type: "message",
          id: generateItemId("msg"),
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: msg.content,
              annotations: [],
              logprobs: [],
            },
          ],
        };
        outputItems.push(outputMessage);
        assistantTurnOrder.push(messageIndex);
        itemOrder.push("output");
      }
      for (const call of msg.tool_calls ?? []) {
        outputItems.push({
          type: "function_call",
          id: responsesFunctionCallItemId(call.item_id) ?? generateItemId("fc"),
          call_id: call.id,
          name: call.function.name,
          arguments: wireArguments(call.function.arguments),
          status: call.incomplete ? "incomplete" : "completed",
        });
        assistantTurnOrder.push(messageIndex);
        itemOrder.push("output");
      }
    } else if (msg.role === "tool") {
      outputItems.push({
        type: "function_call_output",
        id: generateItemId("fco"),
        call_id: msg.tool_call_id ?? "",
        output: msg.content,
        status: "completed",
      });
      itemOrder.push("output");
      assistantTurnOrder.push(null);
    }
  }

  // Map terminated_by to status
  const status =
    result.terminated_by === "judge"
      ? "completed"
      : result.terminated_by === "error"
        ? "failed"
        : "incomplete";
  const incompleteDetails: ResponseResource["incomplete_details"] =
    status === "incomplete"
      ? { reason: `${result.terminated_by}: ${result.reason}` }
      : null;

  // Build usage from token_usage
  let usageData: Usage | null = null;
  if (result.token_usage.total_tokens > 0) {
    usageData = {
      input_tokens: result.token_usage.prompt_tokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: result.token_usage.completion_tokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: result.token_usage.total_tokens,
    };
  }

  return {
    id: generateItemId("resp"),
    object: "response",
    created_at: now,
    completed_at: status === "completed" ? now : null,
    status,
    incomplete_details: incompleteDetails,
    model,
    previous_response_id: null,
    instructions: null,
    input: inputItems,
    output: outputItems,
    error: result.terminated_by === "error" ? { message: result.reason } : null,
    tools: [],
    tool_choice: "auto",
    truncation: "disabled",
    parallel_tool_calls: false,
    text: {
      format: { type: "text" },
    },
    top_p: 1,
    presence_penalty: 0,
    frequency_penalty: 0,
    top_logprobs: 0,
    temperature: 1,
    reasoning: null,
    user: null,
    usage: usageData,
    token_usage_known: result.token_usage_known ?? true,
    max_output_tokens: null,
    max_tool_calls: null,
    store: false,
    background: false,
    service_tier: "default",
    metadata: {
      framework: "simulation",
      goal_achieved: result.goal_achieved,
      goal_completion_score: result.goal_completion_score,
      terminated_by: result.terminated_by,
      reason: result.reason,
      turn_count: result.turn_count,
      rules_broken: result.rules_broken,
      ...(result.criteria_results && {
        criteria_results: result.criteria_results,
      }),
      criteria_verified: result.criteria_verified ?? null,
      criteria_meta: jsonable(result.metadata.criteria_meta, "criteria_meta"),
      criteria_errors: jsonable(
        result.metadata.criteria_errors,
        "criteria_errors",
      ),
      scorer_errors: jsonable(result.metadata.scorer_errors, "scorer_errors"),
      datapoint_id: jsonable(result.metadata.datapoint_id, "datapoint_id"),
      [RESPONSES_ITEM_ORDER_KEY]: itemOrder,
      [RESPONSES_ASSISTANT_TURN_ORDER_KEY]: assistantTurnOrder,
      ...(result.turn_metrics.length > 0 && {
        turn_metrics: result.turn_metrics,
      }),
    },
    safety_identifier: null,
    prompt_cache_key: null,
  } as ResponseResource;
}

function jsonable(value: unknown, key: string): unknown {
  try {
    return JSON.parse(jsonWithFallback(value));
  } catch {
    console.warn(
      `simulation metadata key '${key}' is not serializable; publishing text`,
    );
    return String(value);
  }
}
