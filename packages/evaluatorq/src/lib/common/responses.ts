import type { z } from "zod/v4";

import { toStrictSchema } from "../integrations/simulation/utils/strict-schema.js";
import { getField } from "./fields.js";

export type WireSchema = Record<string, unknown>;

export function scrubWireSchema(schema: WireSchema): WireSchema {
  const { description: _description, ...wire } = schema;
  const properties = wire.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (properties) {
    wire.properties = Object.fromEntries(
      Object.entries(properties).map(([key, property]) => {
        // A default is parser-side: the strict schema still requires the field,
        // and advertising the default tells the model the opposite.
        const { default: _default, ...kept } = property;
        return [key, kept];
      }),
    );
  }
  return wire;
}

export function responsesTextConfig(
  name: string,
  schema: z.ZodObject,
  options: { scrub?: boolean } = {},
): { format: Record<string, unknown> } {
  const strict = toStrictSchema(schema);
  return {
    format: {
      type: "json_schema",
      strict: true,
      name,
      schema: options.scrub ? scrubWireSchema(strict) : strict,
    },
  };
}

function items(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function firstResponsesRefusal(response: unknown): string | null {
  for (const item of items(getField(response, "output"))) {
    for (const part of items(getField(item, "content"))) {
      if (getField(part, "type") === "refusal") {
        return (getField(part, "refusal") as string) || "";
      }
    }
  }
  return null;
}

export function responsesStopReason(response: unknown): string | null {
  const nested = getField(getField(response, "incomplete_details"), "reason");
  if (nested === "max_output_tokens") {
    return "length";
  }
  const stopReason = getField(response, "stop_reason");
  if (typeof stopReason === "string") {
    return stopReason === "max_output_tokens" ? "length" : stopReason;
  }
  return typeof nested === "string" ? nested : null;
}

export function responsesOutputText(response: unknown): string {
  const direct = getField(response, "output_text");
  if (typeof direct === "string" && direct) {
    return direct;
  }
  const texts: string[] = [];
  for (const item of items(getField(response, "output"))) {
    for (const part of items(getField(item, "content"))) {
      if (getField(part, "type") === "output_text") {
        texts.push(String(getField(part, "text") ?? ""));
      }
    }
  }
  return texts.join("");
}

export function parseResponsesResponse<S extends z.ZodType>(
  response: unknown,
  schema: S,
): { outputParsed: z.infer<S> | null } {
  const raw = responsesOutputText(response);
  return { outputParsed: raw ? schema.parse(JSON.parse(raw)) : null };
}
