/**
 * Input sanitization utilities for prompt injection prevention.
 */

const VALID_TAG = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

function escapeAngleBrackets(text: string): string {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Wrap user-controlled text in delimiters to prevent prompt injection.
 *
 * Uses XML-like tags to clearly separate user content from system
 * instructions in LLM prompts. Any tag spelling that could close the
 * delimiter is escaped, including spaced, attributed and unterminated forms.
 *
 * @param text - User-controlled text to wrap
 * @param options.tag - Delimiter tag name. Defaults to "data".
 * @returns Delimited text safe for prompt interpolation
 */
export function delimit(text: string, options?: { tag?: string }): string {
  const tag = options?.tag ?? "data";
  if (!VALID_TAG.test(tag)) {
    throw new Error(`Invalid delimiter tag: ${JSON.stringify(tag)}`);
  }

  const opener = `<(?:\\s*/\\s*|\\s*)${tag}(?![a-zA-Z0-9_-])`;
  const complete = new RegExp(`${opener}[^<>]*>`, "gi");
  const unterminated = new RegExp(`${opener}(?:[^<>]*<[^>]*(?:>|$))?`, "gi");
  const tagName = new RegExp(tag, "i");

  const sanitized = text
    .replace(/&/g, "&amp;") // must be first
    .replace(complete, (match) =>
      escapeAngleBrackets(match.replace(tagName, tag)),
    )
    .replace(unterminated, escapeAngleBrackets);

  return `<${tag}>${sanitized}</${tag}>`;
}
