import { pythonJson } from "../formats/json.js";
import { PYTHON_SHAPES, type ShapeRef } from "./python-shapes.js";

export type PythonModel = keyof typeof PYTHON_SHAPES & string;

const BY_PYTHON = new Map<string, Map<string, [string, ShapeRef]>>();

function byPython(model: string): Map<string, [string, ShapeRef]> {
  let map = BY_PYTHON.get(model);
  if (!map) {
    map = new Map();
    for (const [camel, [python, ref]] of Object.entries(
      PYTHON_SHAPES[model] ?? {},
    ))
      map.set(python, [camel, ref]);
    BY_PYTHON.set(model, map);
  }
  return map;
}

export const isPlain = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const camelToSnake = (key: string): string =>
  key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

export const snakeToCamel = (key: string): string =>
  key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

function convert(value: unknown, ref: ShapeRef, write: boolean): unknown {
  if (ref === null) return value;
  if (Array.isArray(value)) return value.map((v) => convert(v, ref, write));
  if (!isPlain(value)) return value;
  if (typeof ref !== "string")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, convert(v, ref[1], write)]),
    );
  const fields = PYTHON_SHAPES[ref] ?? {};
  const reverse = byPython(ref);
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const known = write
      ? (fields[key] ??
        (reverse.has(key) ? [key, reverse.get(key)?.[1] ?? null] : null))
      : (reverse.get(key) ?? (fields[key] ? [key, fields[key][1]] : null));
    if (known) out[known[0]] = convert(child, known[1], write);
    else out[write ? camelToSnake(key) : snakeToCamel(key)] = child;
  }
  return out;
}

const plain = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(
      value,
      function (this: Record<string, unknown>, key, serialized) {
        const original = this[key];
        return original instanceof Set ? [...original] : serialized;
      },
    ) ?? "null",
  );

export function toPythonKeys(value: unknown, model: PythonModel): unknown {
  return convert(plain(value), model, true);
}

export function fromPythonKeys(value: unknown, model: PythonModel): unknown {
  return convert(value, model, false);
}

/** Python `json.dumps(value, indent=2)`, which escapes everything outside printable ASCII. */
export function pythonJsonDumps(value: unknown): string {
  return pythonJson(plain(value), { indent: 2, ensureAscii: true });
}
