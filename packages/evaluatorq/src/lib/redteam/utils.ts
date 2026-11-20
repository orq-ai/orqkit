export { xmlEscape } from "../common/sanitize.js";
export function safeSubstitute(
  template: string,
  replacements: Record<string, string>,
): string {
  const keys = Object.keys(replacements);
  if (!keys.length) return template;
  const pattern = new RegExp(
    keys.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
    "gu",
  );
  return template.replace(pattern, (key) => replacements[key] as string);
}
