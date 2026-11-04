/**
 * JSON extraction utilities for parsing LLM responses.
 */

/**
 * Regex pattern for markdown code blocks, capturing language tag and body.
 */
const CODE_BLOCK_PATTERN = /```([^\r\n`]*)\r?\n?([\s\S]*?)\n?```/gi;

function isValidJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract JSON from LLM response, handling markdown code blocks.
 *
 * Handles:
 * - Multiple code blocks: json-tagged ones are tried first, and the first
 *   body that parses wins, so an illustrative block cannot shadow the answer
 * - Plain JSON arrays or objects (no code block): whichever opens first wins,
 *   so an array nested in an object is not mistaken for the answer
 *
 * @param content - Raw LLM response content
 * @returns Extracted JSON string, stripped of whitespace
 */
export function extractJsonFromResponse(content: string): string {
  if (!content) {
    return "";
  }

  const blocks = [...content.matchAll(CODE_BLOCK_PATTERN)].map((match) => ({
    isJson: (match[1] ?? "").trim().toLowerCase() === "json",
    body: (match[2] ?? "").trim(),
  }));
  const ordered = [
    ...blocks.filter((block) => block.isJson),
    ...blocks.filter((block) => !block.isJson),
  ];
  for (const block of ordered) {
    if (block.body && isValidJson(block.body)) {
      return block.body;
    }
  }

  const objectStart = content.indexOf("{");
  const arrayStart = content.indexOf("[");
  const objectFirst =
    objectStart !== -1 && (arrayStart === -1 || objectStart < arrayStart);
  const pairs: Array<[string, string]> = objectFirst
    ? [
        ["{", "}"],
        ["[", "]"],
      ]
    : [
        ["[", "]"],
        ["{", "}"],
      ];

  for (const [open, close] of pairs) {
    const json = extractBalanced(content, open, close);
    if (json) return json;
  }

  // Fallback: return trimmed content as-is
  return content.trim();
}

/**
 * Find the outermost balanced pair of open/close characters in content.
 * Respects JSON string literals to avoid counting brackets inside strings.
 */
function extractBalancedFrom(
  content: string,
  open: string,
  close: string,
  startIdx: number,
): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIdx; i < content.length; i++) {
    const ch = content[i] as string;

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) {
        return content.slice(startIdx, i + 1);
      }
    }
  }

  return null;
}

/**
 * Find the outermost balanced pair of open/close characters in content.
 * Tries each candidate occurrence and returns the first that parses as valid JSON.
 * Falls back to the first balanced extraction if none parse.
 */
function extractBalanced(
  content: string,
  open: string,
  close: string,
): string | null {
  let firstMatch: string | null = null;
  let searchFrom = 0;

  while (searchFrom < content.length) {
    const idx = content.indexOf(open, searchFrom);
    if (idx === -1) break;

    const candidate = extractBalancedFrom(content, open, close, idx);
    if (!candidate) {
      searchFrom = idx + 1;
      continue;
    }

    if (!firstMatch) firstMatch = candidate;

    try {
      JSON.parse(candidate);
      return candidate; // Valid JSON — use it
    } catch {
      // Not valid JSON, try next occurrence
    }

    searchFrom = idx + 1;
  }

  return firstMatch;
}
