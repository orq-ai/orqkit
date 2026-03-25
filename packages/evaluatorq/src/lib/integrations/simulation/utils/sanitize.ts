/**
 * Input sanitization utilities for prompt injection prevention.
 */

/**
 * Wrap user-controlled text in delimiters to prevent prompt injection.
 *
 * Uses XML-like data tags to clearly separate user content from
 * system instructions in LLM prompts. The closing tag in the input
 * is escaped to prevent breakout.
 *
 * @param text - User-controlled text to wrap
 * @returns Delimited text safe for prompt interpolation
 */
export function delimit(text: string): string {
  const sanitized = text
    .replace(/<data>/gi, "&lt;data&gt;")
    .replace(/<\/data>/gi, "&lt;/data&gt;");
  return `<data>${sanitized}</data>`;
}
