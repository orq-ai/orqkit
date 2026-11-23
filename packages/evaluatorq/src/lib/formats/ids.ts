import { createHash } from "node:crypto";

import { pythonJson } from "./json.js";

export function stableHex(parts: readonly string[], length: number): string {
  const input = parts.join("\0");
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = input.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff))
        throw new TypeError("Cannot encode an unpaired Unicode surrogate");
    } else if (code >= 0xdc00 && code <= 0xdfff)
      throw new TypeError("Cannot encode an unpaired Unicode surrogate");
  }
  return createHash("sha256")
    .update(input, "utf8")
    .digest("hex")
    .slice(0, length);
}
export function contentSeed(value: unknown): string {
  return createHash("sha256")
    .update(
      pythonJson(value, { sortKeys: true, compact: true, defaultString: true }),
      "utf8",
    )
    .digest("hex");
}
