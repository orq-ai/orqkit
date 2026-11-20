export function getField(
  obj: unknown,
  name: string,
  defaultValue: unknown = undefined,
): unknown {
  if (obj === null || typeof obj !== "object" || !(name in obj)) {
    return defaultValue;
  }
  return (obj as Record<string, unknown>)[name];
}
