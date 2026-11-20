import { z } from "zod/v4";

import { parseJuryResult, parseUsage } from "../contracts.js";

export function savedAdapter<T>(parse: (value: unknown) => T) {
  return z.unknown().transform((value, ctx) => {
    try {
      return parse(value);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : String(error),
      });
      return z.NEVER;
    }
  });
}
export const savedUsage = savedAdapter(parseUsage);
export const savedJury = savedAdapter(parseJuryResult);
export function savedKeys<T extends z.ZodObject>(schema: T) {
  return z.preprocess((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return value;
    const raw = { ...value } as Record<string, unknown>;
    for (const key of Object.keys(schema.shape)) {
      const snake = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
      if (snake === key) continue;
      if (!(key in raw) && snake in raw) raw[key] = raw[snake];
      delete raw[snake];
    }
    return raw;
  }, schema);
}
