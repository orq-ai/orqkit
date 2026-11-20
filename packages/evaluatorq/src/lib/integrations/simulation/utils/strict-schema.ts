import OpenAI from "openai";
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
  return wire;
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
  if (!(err instanceof OpenAI.APIError) || err.status !== 400) return false;
  return SCHEMA_REJECTION.test(err.message);
}
