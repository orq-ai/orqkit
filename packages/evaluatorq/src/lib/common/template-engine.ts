export const VALID_PATH_PATTERN =
  /^[a-zA-Z_][a-zA-Z0-9_]*(?:\.(?:[a-zA-Z_][a-zA-Z0-9_]*|\d+)|\[-?\d+\])*$/;

// `[^\n]` rather than `.`: JS `.` also stops at \r and the Unicode line separators.
const CURLY = /{{([^\n]*?)}}/g;
const BRACKET_INDEX = /\[(-?\d+)\]/g;
const NOT_FOUND = Symbol("not-found");

// The namespace objects must stay resolvable for subpaths, but a bare
// {{input}} must not dump them.
const RESERVED_BARE_KEYS = new Set([
  "input",
  "output",
  "log",
  "response_a",
  "response_b",
]);

type Replacements = Record<string, unknown>;

export function isValidTemplatePath(path: string): boolean {
  return VALID_PATH_PATTERN.test(path);
}

function isDict(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resolveNested(data: Replacements, path: string): unknown {
  let current: unknown = data;
  for (const segment of path.split(".")) {
    const bracketAt = segment.indexOf("[");
    const key = bracketAt === -1 ? segment : segment.slice(0, bracketAt);
    if (key) {
      if (!isDict(current) || !Object.hasOwn(current, key)) {
        return NOT_FOUND;
      }
      current = current[key];
    }
    if (bracketAt === -1) {
      continue;
    }
    for (const match of segment.matchAll(BRACKET_INDEX)) {
      if (!Array.isArray(current)) {
        return NOT_FOUND;
      }
      let index = Number(match[1]);
      if (index < 0) {
        index += current.length;
      }
      if (index < 0 || index >= current.length) {
        return NOT_FOUND;
      }
      current = current[index];
    }
  }
  return current;
}

function placeholderPath(body: string): string | null {
  const path = body.trim();
  if (/[ \t\n\r]/.test(path)) {
    return null;
  }
  if (!isValidTemplatePath(path)) {
    console.warn(`Rejected template path: '${path}'`);
    return null;
  }
  if (RESERVED_BARE_KEYS.has(path)) {
    console.warn(
      `Bare reserved template key '${path}' left unresolved, use a dotted path instead (e.g. '${path}.<field>').`,
    );
    return null;
  }
  return path;
}

export function extractTemplatePaths(template: string): string[] {
  const paths: string[] = [];
  for (const match of template.matchAll(CURLY)) {
    const path = placeholderPath(match[1] as string);
    if (path !== null && !paths.includes(path)) {
      paths.push(path);
    }
  }
  return paths;
}

export function resolveTemplatePath(
  replacements: Replacements,
  path: string,
  options: { preferNested?: boolean } = {},
): { found: boolean; value: unknown } {
  const preferNested = options.preferNested ?? false;
  const hasFlat = Object.hasOwn(replacements, path);
  if (!preferNested && hasFlat) {
    return { found: true, value: replacements[path] };
  }
  const value = resolveNested(replacements, path);
  if (value !== NOT_FOUND) {
    return { found: true, value };
  }
  return hasFlat
    ? { found: true, value: replacements[path] }
    : { found: false, value: null };
}

function asciiJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(
    /[\u007f-\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function format(value: unknown): string {
  if (isDict(value) || Array.isArray(value)) {
    return asciiJson(value);
  }
  if (typeof value === "string") {
    return value;
  }
  // Parity with the platform engine, which renders Python's True/False/None.
  if (value === null || value === undefined) {
    return "None";
  }
  if (typeof value === "boolean") {
    return value ? "True" : "False";
  }
  return String(value);
}

// One replace pass, so a value containing "{{...}}" is never re-expanded.
export function renderTemplate(
  template: string,
  replacements: Replacements,
): string {
  return template.replace(CURLY, (whole, body: string) => {
    const path = placeholderPath(body);
    if (path === null) {
      return whole;
    }
    const { found, value } = resolveTemplatePath(replacements, path);
    return found ? format(value) : whole;
  });
}
