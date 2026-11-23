import { createRequire } from "node:module";

import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { Ajv2019 } from "ajv/dist/2019.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import draft6 from "ajv/dist/refs/json-schema-draft-06.json" with {
  type: "json",
};

import { codepointCompare, pythonStrip, SPACE } from "../common/sanitize.js";
import { pythonJson } from "../formats/json.js";
import draft3Meta from "./draft3-meta.json" with { type: "json" };
import { pythonRegexEngine } from "./python-regex.js";

type Row = Record<string, unknown>;
type Error = ErrorObject & {
  data?: unknown;
  schema?: unknown;
  parentSchema?: Row;
  propertyName?: string;
};
const require = createRequire(import.meta.url);
const emptyEnums = new WeakSet<object>();
const cache = new WeakMap<
  Row,
  { signature: string; validate: ValidateFunction }
>();
const record = (value: unknown): value is Row =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function repr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number")
    return Number.isNaN(value)
      ? "nan"
      : value === Infinity
        ? "inf"
        : value === -Infinity
          ? "-inf"
          : pythonJson(value);
  if (typeof value === "string") {
    const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
    let out = quote;
    for (const char of value) {
      const code = char.codePointAt(0) ?? 0;
      if (char === quote || char === "\\") out += `\\${char}`;
      else if (char === "\t") out += "\\t";
      else if (char === "\n") out += "\\n";
      else if (char === "\r") out += "\\r";
      else if (char !== " " && /[\p{C}\p{Z}]/u.test(char))
        out +=
          code <= 255
            ? `\\x${code.toString(16).padStart(2, "0")}`
            : code <= 65535
              ? `\\u${code.toString(16).padStart(4, "0")}`
              : `\\U${code.toString(16).padStart(8, "0")}`;
      else out += char;
    }
    return out + quote;
  }
  if (Array.isArray(value)) return `[${value.map(repr).join(", ")}]`;
  if (record(value))
    return `{${Object.entries(value)
      .map(([key, v]) => `${repr(key)}: ${repr(v)}`)
      .join(", ")}}`;
  return String(value);
}
const legacyTypes = new WeakMap<object, unknown>();
const legacyDisallow = new WeakMap<object, unknown>();
const legacyRequired = new WeakSet<object>();
function draft3Schema(schema: unknown): unknown {
  if (!record(schema)) return schema;
  const out: Row = {},
    ignored = new Set([
      "allOf",
      "anyOf",
      "oneOf",
      "not",
      "const",
      "contains",
      "propertyNames",
      "minProperties",
      "maxProperties",
      "dependentRequired",
      "dependentSchemas",
      "unevaluatedProperties",
      "unevaluatedItems",
      "prefixItems",
      "if",
      "then",
      "else",
      "$dynamicRef",
      "$recursiveRef",
      "required",
      "divisibleBy",
      "multipleOf",
      "disallow",
      "extends",
      "type",
      "$async",
      "nullable",
    ]),
    maps = new Set(["properties", "patternProperties", "definitions", "$defs"]);
  for (const [key, value] of Object.entries(schema)) {
    if (ignored.has(key)) continue;
    if (key === "$schema") {
      out[key] = "http://json-schema.org/draft-04/schema#";
      continue;
    }
    if (maps.has(key) && record(value))
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [
          name,
          draft3Schema(child),
        ]),
      );
    else if (key === "items" && Array.isArray(value))
      out[key] = value.map(draft3Schema);
    else if (["items", "additionalProperties", "additionalItems"].includes(key))
      out[key] = draft3Schema(value);
    else if (key === "dependencies" && record(value))
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, dependency]) => [
          name,
          typeof dependency === "string"
            ? [dependency]
            : Array.isArray(dependency)
              ? dependency
              : draft3Schema(dependency),
        ]),
      );
    else out[key] = value;
  }
  const properties = record(schema.properties) ? schema.properties : {};
  const required = Object.entries(properties)
    .filter(([, child]) => record(child) && child.required === true)
    .map(([name]) => name);
  if (required.length) {
    out.required = required;
    legacyRequired.add(out);
  }
  if (Object.hasOwn(schema, "divisibleBy")) out.multipleOf = schema.divisibleBy;
  const constraint = (type: unknown): Row => {
    const types = Array.isArray(type) ? type : [type];
    if (types.includes("any")) return {};
    const members = types.map((value) =>
      typeof value === "string" ? { type: value } : draft3Schema(value),
    );
    return members.length === 1
      ? (members[0] as Row)
      : members.length
        ? { anyOf: members }
        : { not: {} };
  };
  if (Object.hasOwn(schema, "type")) {
    const type = schema.type,
      c = constraint(type);
    Object.assign(out, c);
    if (Array.isArray(type)) legacyTypes.set(out, type);
  }
  const conjunction: unknown[] = [];
  if (Object.hasOwn(schema, "extends"))
    conjunction.push(
      ...(Array.isArray(schema.extends)
        ? schema.extends
        : [schema.extends]
      ).map(draft3Schema),
    );
  if (Object.hasOwn(schema, "disallow"))
    for (const type of Array.isArray(schema.disallow)
      ? schema.disallow
      : [schema.disallow]) {
      const denied = { not: constraint(type) };
      legacyDisallow.set(denied, type);
      conjunction.push(denied);
    }
  if (conjunction.length) out.allOf = conjunction;
  return out;
}

function dialectSchema(value: unknown, ignored: ReadonlySet<string>): unknown {
  if (typeof value === "boolean" || !record(value)) return value;
  const out: Row = {};
  const maps = new Set([
      "properties",
      "patternProperties",
      "definitions",
      "$defs",
      "dependentSchemas",
    ]),
    single = new Set([
      "additionalProperties",
      "additionalItems",
      "contains",
      "unevaluatedProperties",
      "unevaluatedItems",
      "propertyNames",
      "if",
      "then",
      "else",
      "not",
      "contentSchema",
    ]),
    lists = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
  for (const [key, item] of Object.entries(value)) {
    if (ignored.has(key) || key === "$async" || key === "nullable") continue;
    if (maps.has(key) && record(item))
      out[key] = Object.fromEntries(
        Object.entries(item).map(([name, child]) => [
          name,
          dialectSchema(child, ignored),
        ]),
      );
    else if (single.has(key)) out[key] = dialectSchema(item, ignored);
    else if ((lists.has(key) || key === "items") && Array.isArray(item))
      out[key] = item.map((child) => dialectSchema(child, ignored));
    else if (key === "items") out[key] = dialectSchema(item, ignored);
    else if (key === "dependencies" && record(item))
      out[key] = Object.fromEntries(
        Object.entries(item).map(([name, child]) => [
          name,
          Array.isArray(child) ? child : dialectSchema(child, ignored),
        ]),
      );
    else out[key] = item;
  }
  if (legacyTypes.has(value)) legacyTypes.set(out, legacyTypes.get(value));
  if (legacyDisallow.has(value))
    legacyDisallow.set(out, legacyDisallow.get(value));
  if (legacyRequired.has(value)) legacyRequired.add(out);
  if (Array.isArray(value.enum) && value.enum.length === 0) {
    delete out.enum;
    const never = { not: {} };
    emptyEnums.add(never);
    out.allOf = [...(Array.isArray(out.allOf) ? out.allOf : []), never];
  }
  return out;
}
function validator(schema: Row): ValidateFunction {
  const signature = pythonJson(schema),
    saved = cache.get(schema);
  if (saved?.signature === signature) return saved.validate;
  const dialect = typeof schema.$schema === "string" ? schema.$schema : "",
    options = {
      allErrors: true,
      strict: false,
      validateFormats: false,
      verbose: true,
      code: { regExp: pythonRegexEngine },
      ownProperties: true,
      logger: false as const,
      ignoreKeywordsWithRef: /draft-0[3467]/.test(dialect),
    };
  let ajv: Ajv;
  if (dialect.includes("draft-04") || dialect.includes("draft-03")) {
    const Ajv4 = require("ajv-draft-04") as typeof Ajv2020;
    ajv = new Ajv4(options);
  } else if (dialect.includes("draft-06") || dialect.includes("draft-07")) {
    ajv = new Ajv(options);
    if (dialect.includes("draft-06")) ajv.addMetaSchema(draft6);
  } else if (dialect.includes("2019-09")) ajv = new Ajv2019(options);
  else ajv = new Ajv2020(options);
  const legacy = dialect.includes("draft-03");
  const input = legacy ? (draft3Schema(schema) as Row) : { ...schema };
  if (legacy) {
    const meta = draft3Schema(draft3Meta) as Row;
    ajv.addMetaSchema(meta, "http://json-schema.org/draft-03/schema#");
    if (!ajv.validate("http://json-schema.org/draft-03/schema#", schema))
      throw new TypeError(
        `unusable tool schema: ${ajv.errorsText(ajv.errors)}`,
      );
  }
  if (dialect && !/draft-0[467]|2019-09|2020-12/.test(dialect))
    delete input.$schema;
  const ignored = new Set<string>(
    dialect.includes("draft-04") || legacy
      ? [
          "$dynamicRef",
          "$recursiveRef",
          "const",
          "contains",
          "dependentRequired",
          "dependentSchemas",
          "if",
          "then",
          "else",
          "prefixItems",
          "propertyNames",
          "unevaluatedItems",
          "unevaluatedProperties",
          "minContains",
          "maxContains",
        ]
      : dialect.includes("draft-06")
        ? [
            "$dynamicRef",
            "$recursiveRef",
            "dependentRequired",
            "dependentSchemas",
            "if",
            "then",
            "else",
            "prefixItems",
            "unevaluatedItems",
            "unevaluatedProperties",
            "minContains",
            "maxContains",
          ]
        : dialect.includes("draft-07")
          ? [
              "$dynamicRef",
              "$recursiveRef",
              "dependentRequired",
              "dependentSchemas",
              "prefixItems",
              "unevaluatedItems",
              "unevaluatedProperties",
              "minContains",
              "maxContains",
            ]
          : dialect.includes("2019-09")
            ? ["$dynamicRef", "dependencies", "prefixItems"]
            : ["$recursiveRef", "additionalItems", "dependencies"],
  );
  try {
    if (!ajv.validateSchema(input))
      throw new TypeError(ajv.errorsText(ajv.errors));
    const validate = ajv.compile(dialectSchema(input, ignored) as Row);
    cache.set(schema, { signature, validate });
    return validate;
  } catch (error) {
    throw new TypeError(
      `unusable tool schema: ${error instanceof globalThis.Error ? error.message : String(error)}`,
    );
  }
}
function unexpected(prefix: string, names: unknown[]): string {
  return `${prefix} (${names.map(repr).join(", ")} ${names.length === 1 ? "was" : "were"} unexpected)`;
}
function extraNames(data: unknown, schema: Row): string[] {
  if (!record(data)) return [];
  const properties = record(schema.properties) ? schema.properties : {},
    patterns = record(schema.patternProperties)
      ? Object.keys(schema.patternProperties)
      : [];
  return Object.keys(data)
    .filter(
      (key) =>
        !Object.hasOwn(properties, key) &&
        !patterns.some((pattern) => pythonRegexEngine(pattern, "u").test(key)),
    )
    .sort(codepointCompare);
}
function message(error: Error, dialect: string, errors: Error[]): string {
  const data = error.data,
    shown = repr(data),
    params = error.params as Row,
    schema = error.parentSchema ?? {},
    limit = params.limit;
  switch (error.keyword) {
    case "type":
      return `${shown} is not of type ${Array.isArray(params.type) ? params.type.map(repr).join(", ") : repr(params.type)}`;
    case "required":
      return `${repr(params.missingProperty)} is a required property`;
    case "enum":
      return `${shown} is not one of ${repr(error.schema)}`;
    case "const":
      return `${repr(error.schema)} was expected`;
    case "minimum":
      return `${shown} is less than the minimum of ${repr(limit)}`;
    case "maximum":
      return `${shown} is greater than the maximum of ${repr(limit)}`;
    case "exclusiveMinimum":
      return `${shown} is less than or equal to the minimum of ${repr(limit)}`;
    case "exclusiveMaximum":
      return `${shown} is greater than or equal to the maximum of ${repr(limit)}`;
    case "multipleOf":
      return `${shown} is not a multiple of ${repr(params.multipleOf)}`;
    case "minLength":
    case "minItems":
      return `${shown} is too short`;
    case "maxLength":
    case "maxItems":
      return `${shown} is too long`;
    case "pattern":
      return `${shown} does not match ${repr(params.pattern)}`;
    case "minProperties":
      return `${shown} does not have enough properties`;
    case "maxProperties":
      return `${shown} has too many properties`;
    case "uniqueItems":
      return `${shown} has non-unique elements`;
    case "additionalProperties": {
      const names = extraNames(data, schema),
        patterns = record(schema.patternProperties)
          ? Object.keys(schema.patternProperties).sort(codepointCompare)
          : [];
      if (patterns.length)
        return `${names.map(repr).join(", ")} ${names.length === 1 ? "does" : "do"} not match any of the regexes: ${patterns.map(repr).join(", ")}`;
      return unexpected("Additional properties are not allowed", names);
    }
    case "unevaluatedProperties":
      return unexpected(
        "Unevaluated properties are not allowed",
        errors
          .filter(
            (e) =>
              e.keyword === "unevaluatedProperties" &&
              e.instancePath === error.instancePath &&
              e.schemaPath === error.schemaPath,
          )
          .map((e) => e.params.unevaluatedProperty)
          .sort((a, b) => codepointCompare(String(a), String(b))),
      );
    case "additionalItems":
      return unexpected(
        "Additional items are not allowed",
        Array.isArray(data) ? data.slice(Number(params.limit)) : [],
      );
    case "items":
    case "unevaluatedItems": {
      const count = Array.isArray(data) ? data.length : Number(params.limit),
        allowed = Number(
          params.limit ??
            (Array.isArray(schema.prefixItems) ? schema.prefixItems.length : 0),
        );
      if (error.keyword === "unevaluatedItems")
        return unexpected(
          "Unevaluated items are not allowed",
          Array.isArray(data) ? data.slice(allowed) : [],
        );
      return `Expected at most ${allowed} item${allowed === 1 ? "" : "s"} but found ${count - allowed} extra: ${repr(Array.isArray(data) ? (data.length - allowed === 1 ? data[allowed] : data.slice(allowed)) : [])}`;
    }
    case "dependencies":
    case "dependentRequired":
      return `${repr(params.missingProperty)} is a dependency of ${repr(params.property)}`;
    case "anyOf":
      if (error.parentSchema && legacyTypes.has(error.parentSchema))
        return `${shown} is not of type ${(legacyTypes.get(error.parentSchema) as unknown[]).map(repr).join(", ")}`;
      return `${shown} is not valid under any of the given schemas`;
    case "oneOf": {
      const passing = params.passingSchemas;
      if (
        Array.isArray(passing) &&
        passing.length > 1 &&
        Array.isArray(error.schema)
      )
        return `${shown} is valid under each of ${[...passing.slice(1), passing[0]].map((index) => repr((error.schema as unknown[])[Number(index)])).join(", ")}`;
      return `${shown} is not valid under any of the given schemas`;
    }
    case "not":
      if (error.parentSchema && legacyDisallow.has(error.parentSchema))
        return `${repr(legacyDisallow.get(error.parentSchema))} is disallowed for ${shown}`;
      if (error.parentSchema && legacyTypes.has(error.parentSchema))
        return `${shown} is not of type ${(legacyTypes.get(error.parentSchema) as unknown[]).map(repr).join(", ")}`;
      if (error.parentSchema && emptyEnums.has(error.parentSchema))
        return `${shown} is not one of []`;
      return `${shown} should not be valid under ${repr(error.schema)}`;
    case "false schema":
      return `False schema does not allow ${shown}`;
    case "contains": {
      const items = Array.isArray(data) ? data : [],
        contains = schema.contains;
      const test = record(contains)
          ? validator({
              ...contains,
              ...(schema.$defs ? { $defs: schema.$defs } : {}),
              ...(schema.definitions
                ? { definitions: schema.definitions }
                : {}),
            })
          : null,
        count = test
          ? items.filter((item) => test(item)).length
          : contains === true
            ? items.length
            : 0;
      if (!count)
        return /draft-0[67]/.test(dialect)
          ? `None of ${shown} are valid under the given schema`
          : `${shown} does not contain items matching the given schema`;
      if (typeof params.maxContains === "number" && count > params.maxContains)
        return `Too many items match the given schema (expected at most ${params.maxContains})`;
      return `Too few items match the given schema (expected at least ${params.minContains ?? 1} but only ${count} matched)`;
    }
    default:
      return error.message ?? "schema validation failed";
  }
}
function parts(pointer: string, data: unknown): (string | number)[] {
  const path: (string | number)[] = [];
  let current = data;
  for (const key of pointer
    .split("/")
    .slice(1)
    .map((key) => key.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    path.push(Array.isArray(current) ? Number(key) : key);
    current =
      current && typeof current === "object"
        ? (current as Row)[key]
        : undefined;
  }
  return path;
}
function comparePath(a: (string | number)[], b: (string | number)[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i],
      y = b[i];
    if (x === y) continue;
    return typeof x === "number" && typeof y === "number"
      ? x - y
      : codepointCompare(String(x), String(y));
  }
  return a.length - b.length;
}
function schemaOrder(pointer: string, schema: Row): number[] {
  let current: unknown = schema;
  const order: number[] = [];
  for (const key of pointer
    .replace(/^#/, "")
    .split("/")
    .slice(1)
    .map((key) =>
      decodeURIComponent(key).replaceAll("~1", "/").replaceAll("~0", "~"),
    )) {
    if (Array.isArray(current)) {
      order.push(Number(key));
      current = current[Number(key)];
    } else if (record(current)) {
      order.push(Object.keys(current).indexOf(key));
      current = current[key];
    }
  }
  return order;
}
function errorPath(error: Error, args: unknown): (string | number)[] {
  const path = parts(error.instancePath, args);
  if (
    error.keyword === "required" &&
    error.parentSchema &&
    legacyRequired.has(error.parentSchema)
  )
    return [...path, String(error.params.missingProperty)];
  if (
    error.keyword === "false schema" &&
    /\/(?:properties|patternProperties|prefixItems|items)\/[^/]+(?:\/false schema)?$/.test(
      error.schemaPath,
    )
  )
    return path.slice(0, -1);
  return path;
}
export function schemaViolation(schema: Row, args: unknown): string | null {
  const validate = validator(schema);
  if (validate(args)) return null;
  const errors = (validate.errors ?? []) as Error[],
    parents = errors.filter((error) =>
      ["anyOf", "oneOf", "contains"].includes(error.keyword),
    );
  const selected = errors
    .filter(
      (error) =>
        error.keyword !== "if" &&
        error.keyword !== "propertyNames" &&
        !parents.some(
          (parent) =>
            parent !== error &&
            error.schemaPath.startsWith(`${parent.schemaPath}/`),
        ),
    )
    .map((error, index) => ({
      error,
      index,
      path: errorPath(error, args),
    }))
    .sort(
      (a, b) =>
        comparePath(a.path, b.path) ||
        comparePath(
          schemaOrder(
            a.error.parentSchema && emptyEnums.has(a.error.parentSchema)
              ? a.error.schemaPath.replace(/allOf\/\d+\/not$/, "enum")
              : a.error.schemaPath,
            schema,
          ),
          schemaOrder(
            b.error.parentSchema && emptyEnums.has(b.error.parentSchema)
              ? b.error.schemaPath.replace(/allOf\/\d+\/not$/, "enum")
              : b.error.schemaPath,
            schema,
          ),
        ) ||
        a.index - b.index,
    )[0];
  if (!selected) return null;
  const path = selected.path.map(String).join("/") || "$",
    text = pythonStrip(
      `${path}: ${message(selected.error, typeof schema.$schema === "string" ? schema.$schema : "", errors)}`.replace(
        new RegExp(`${SPACE}+`, "g"),
        " ",
      ),
    ),
    chars = Array.from(text);
  return chars.length <= 160 ? text : `${chars.slice(0, 159).join("")}…`;
}
