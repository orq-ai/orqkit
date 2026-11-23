import { z } from "zod/v4";

/**
 * The JSON schema to send for a strict structured call.
 *
 * Not `openai/helpers/zod`: it writes a nullable field as `nullable: true`, which
 * models ignore, so a score that should be null comes back as an invented number.
 * This form spells null as a type, and models do answer null to it.
 */
export function toStrictSchema(schema: z.ZodObject): Record<string, unknown> {
  const { $schema: _draft, ...wire } = z.toJSONSchema(schema);
  return dropNullDefaults(wire) as Record<string, unknown>;
}

function dropNullDefaults(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(dropNullDefaults);
  }
  if (typeof node !== "object" || node === null) {
    return node;
  }
  return Object.fromEntries(
    Object.entries(node).flatMap(([key, value]) =>
      (key === "default" && value === null) ||
      (key === "id" &&
        typeof value === "string" &&
        typeof (node as Record<string, unknown>).type === "string")
        ? []
        : [[key, dropNullDefaults(value)]],
    ),
  );
}

const SCHEMA_REJECTION =
  /schema|response_format|structured output|\bstrict\b|additionalproperties|anyof/i;

/**
 * Whether an error is a provider refusing the schema or the strict flag.
 *
 * A bare 400 is more often a bad parameter or an over-long context, and falling
 * back on those hides the cause and pays for the same failure again.
 */
export function isSchemaRejection(err: unknown): boolean {
  const { status, message } = (err ?? {}) as {
    status?: unknown;
    message?: unknown;
  };
  return (
    status === 400 &&
    typeof message === "string" &&
    SCHEMA_REJECTION.test(message)
  );
}
