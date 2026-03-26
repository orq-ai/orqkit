/**
 * JSON extraction utilities for parsing LLM responses.
 */

/**
 * Regex pattern for extracting JSON from markdown code blocks.
 * Handles ```json ... ``` and ``` ... ``` blocks.
 */
const JSON_BLOCK_PATTERN = /```(?:json)?\s*\n?([\s\S]*?)\n?```/i;

/**
 * Extract JSON from LLM response, handling markdown code blocks.
 *
 * Robust extraction that handles:
 * - ```json ... ``` blocks
 * - ``` ... ``` blocks (no language specifier)
 * - Plain JSON arrays or objects (no code block)
 * - Multiple code blocks (returns first one)
 *
 * @param content - Raw LLM response content
 * @returns Extracted JSON string, stripped of whitespace
 */
export function extractJsonFromResponse(content: string): string {
  if (!content) {
    return "";
  }

  // Try to extract from code block using regex
  const match = JSON_BLOCK_PATTERN.exec(content);
  if (match?.[1]) {
    return match[1].trim();
  }

  // No code block found — try to find the outermost JSON array or object
  // by matching balanced brackets/braces
  const arrayJson = extractBalanced(content, "[", "]");
  if (arrayJson) return arrayJson;

  const objectJson = extractBalanced(content, "{", "}");
  if (objectJson) return objectJson;

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

    if (ch === "\\") {
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
