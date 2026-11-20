import { codepointCompare } from "../common/sanitize.js";

function string(value: string, ensureAscii = true): string {
  const quoted = JSON.stringify(value);
  if (ensureAscii)
    return quoted.replace(
      /[\u007f-\uffff]/g,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
  let out = "";
  for (let i = 0; i < quoted.length; i++) {
    const char = quoted.charAt(i);
    if (
      char === "\\" &&
      quoted.charAt(i + 1) === "u" &&
      /^d[89a-f][0-9a-f]{2}$/i.test(quoted.slice(i + 2, i + 6))
    ) {
      out += String.fromCharCode(
        Number.parseInt(quoted.slice(i + 2, i + 6), 16),
      );
      i += 5;
    } else if (char === "\\") {
      out += quoted.slice(i, i + 2);
      i++;
    } else out += char;
  }
  return out;
}
function decimal(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "Infinity";
  if (value === Number.NEGATIVE_INFINITY) return "-Infinity";
  if (Object.is(value, -0)) return "-0.0";
  const raw = value.toString();
  if (!Number.isInteger(value) && Math.abs(value) < 0.0001) {
    const [mantissa, exponent] = value.toExponential().split("e");
    const e = Number(exponent);
    return `${mantissa}e${e < 0 ? "-" : "+"}${String(Math.abs(e)).padStart(2, "0")}`;
  }
  if (!/[eE]/.test(raw)) return raw;
  const [coefficient, exponent] = raw.split("e"),
    negative = coefficient?.startsWith("-") ?? false,
    unsigned = (coefficient ?? "").replace("-", ""),
    [whole, fraction = ""] = unsigned.split("."),
    digits = (whole ?? "") + fraction,
    point = (whole?.length ?? 0) + Number(exponent);
  const expanded =
    point <= 0
      ? `0.${"0".repeat(-point)}${digits}`
      : point >= digits.length
        ? digits + "0".repeat(point - digits.length)
        : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return negative ? `-${expanded}` : expanded;
}
const plain = (value: object): boolean =>
  Object.getPrototypeOf(value) === Object.prototype ||
  Object.getPrototypeOf(value) === null;
export function pythonJson(
  value: unknown,
  options: {
    sortKeys?: boolean;
    compact?: boolean;
    defaultString?: boolean;
    indent?: number | null;
    ensureAscii?: boolean;
  } = {},
): string {
  if (options.indent != null && !Number.isInteger(options.indent))
    throw new TypeError("JSON indentation must be an integer");
  const pretty = options.indent != null,
    indent = " ".repeat(Math.max(0, options.indent ?? 0));
  const active = new Set<object>(),
    comma = options.compact ? "," : ", ",
    colon = options.compact ? ":" : ": ";
  const container = (
    items: string[],
    open: string,
    close: string,
    depth: number,
  ): string => {
    if (!items.length) return open + close;
    if (!pretty) return open + items.join(comma) + close;
    const prefix = indent.repeat(depth + 1);
    return `${open}\n${prefix}${items.join(`,\n${prefix}`)}\n${indent.repeat(depth)}${close}`;
  };
  const encode = (entry: unknown, depth: number): string => {
    if (entry === null) return "null";
    if (typeof entry === "string") return string(entry, options.ensureAscii);
    if (typeof entry === "boolean") return entry ? "true" : "false";
    if (typeof entry === "number") return decimal(entry);
    if (typeof entry === "bigint") return entry.toString();
    if (
      Array.isArray(entry) ||
      (typeof entry === "object" && entry !== null && plain(entry))
    ) {
      if (active.has(entry)) throw new TypeError("Circular reference detected");
      active.add(entry);
      try {
        if (Array.isArray(entry))
          return container(
            Array.from(entry, (item) => encode(item, depth + 1)),
            "[",
            "]",
            depth,
          );
        const keys = Object.keys(entry);
        if (options.sortKeys) keys.sort(codepointCompare);
        return container(
          keys.map(
            (key) =>
              `${string(key, options.ensureAscii)}${colon}${encode((entry as Record<string, unknown>)[key], depth + 1)}`,
          ),
          "{",
          "}",
          depth,
        );
      } finally {
        active.delete(entry);
      }
    }
    if (options.defaultString)
      return string(String(entry), options.ensureAscii);
    throw new TypeError("Value is not JSON-encodable");
  };
  return encode(value, 0);
}

export function parsePythonJson(text: string): unknown {
  let position = 0;
  const fail = (): never => {
    throw new SyntaxError(`Invalid JSON at position ${position}`);
  };
  const whitespace = () => {
    while (/[ \t\r\n]/.test(text.charAt(position)) && position < text.length)
      position++;
  };
  const quoted = (): string => {
    const start = position++;
    while (position < text.length) {
      const char = text.charAt(position++);
      if (char === '"')
        return JSON.parse(text.slice(start, position)) as string;
      if (char === "\\") position++;
    }
    return fail();
  };
  const value = (): unknown => {
    whitespace();
    const char = text.charAt(position);
    if (char === '"') return quoted();
    if (char === "[") {
      position++;
      whitespace();
      const items: unknown[] = [];
      if (text.charAt(position) === "]") {
        position++;
        return items;
      }
      for (;;) {
        items.push(value());
        whitespace();
        const delimiter = text.charAt(position++);
        if (delimiter === "]") return items;
        if (delimiter !== ",") return fail();
      }
    }
    if (char === "{") {
      position++;
      whitespace();
      const object: Record<string, unknown> = {};
      if (text.charAt(position) === "}") {
        position++;
        return object;
      }
      for (;;) {
        whitespace();
        if (text.charAt(position) !== '"') return fail();
        const key = quoted();
        whitespace();
        if (text.charAt(position++) !== ":") return fail();
        Object.defineProperty(object, key, {
          value: value(),
          writable: true,
          enumerable: true,
          configurable: true,
        });
        whitespace();
        const delimiter = text.charAt(position++);
        if (delimiter === "}") return object;
        if (delimiter !== ",") return fail();
      }
    }
    for (const [token, result] of [
      ["null", null],
      ["true", true],
      ["false", false],
      ["NaN", NaN],
      ["Infinity", Infinity],
      ["-Infinity", -Infinity],
    ] as const) {
      if (text.startsWith(token, position)) {
        position += token.length;
        return result;
      }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      text.slice(position),
    );
    if (number) {
      position += number[0].length;
      return number[0] === "-0" ? 0 : Number(number[0]);
    }
    return fail();
  };
  const parsed = value();
  whitespace();
  if (position !== text.length) return fail();
  return parsed;
}
