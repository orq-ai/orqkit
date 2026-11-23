const JSON_BLOCK_PATTERN =
  /```(?<language>[^\r\n`]*)\r?\n?(?<body>[\s\S]*?)\n?```/gi;

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "object" && value !== null) {
    return Object.keys(value).length > 0;
  }
  return Boolean(value);
}

/** Tolerates messy fallback JSON in a string array instead of failing validation. */
export function coerceStrList(value: unknown): unknown {
  return Array.isArray(value) ? value.filter(isTruthy).map(String) : value;
}

/** Stringifies scalars in a string field; null becomes an empty string. */
export function coerceStr(value: unknown): unknown {
  if (value === null || value === undefined) {
    return "";
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  return value;
}

function isValidJson(candidate: string): boolean {
  try {
    JSON.parse(candidate);
    return true;
  } catch {
    return false;
  }
}

function extractBalancedFrom(
  content: string,
  open: string,
  close: string,
  start: number,
): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < content.length; i += 1) {
    const ch = content[i];
    if (escaped) {
      escaped = false;
    } else if (ch === "\\" && inString) {
      escaped = true;
    } else if (ch === '"') {
      inString = !inString;
    } else if (!inString && ch === open) {
      depth += 1;
    } else if (!inString && ch === close) {
      depth -= 1;
      if (depth === 0) {
        return content.slice(start, i + 1);
      }
    }
  }
  return undefined;
}

function extractBalanced(
  content: string,
  open: string,
  close: string,
): string | undefined {
  let firstMatch: string | undefined;
  let from = 0;

  while (from < content.length) {
    const index = content.indexOf(open, from);
    if (index === -1) {
      break;
    }
    const candidate = extractBalancedFrom(content, open, close, index);
    if (candidate !== undefined) {
      firstMatch ??= candidate;
      if (isValidJson(candidate)) {
        return candidate;
      }
    }
    from = index + 1;
  }
  return firstMatch;
}

/** Pull JSON out of a model response: fenced block first, else outermost structure. */
export function extractJsonFromResponse(content: string): string {
  if (!content) {
    return "";
  }

  // Tagged blocks go first because providers can put an illustrative block of
  // another language before the actual JSON.
  const blocks = [...content.matchAll(JSON_BLOCK_PATTERN)].sort(
    (a, b) =>
      Number(a.groups?.language?.trim().toLowerCase() !== "json") -
      Number(b.groups?.language?.trim().toLowerCase() !== "json"),
  );
  for (const block of blocks) {
    const candidate = block.groups?.body?.trim() ?? "";
    if (isValidJson(candidate)) {
      return candidate;
    }
  }

  // Whichever opener appears first wins, or the inner array of an object would
  // be returned where the caller validates an object.
  const firstObject = content.indexOf("{");
  const firstArray = content.indexOf("[");
  const objectFirst =
    firstObject !== -1 && (firstArray === -1 || firstObject < firstArray);
  const order = objectFirst
    ? [
        ["{", "}"],
        ["[", "]"],
      ]
    : [
        ["[", "]"],
        ["{", "}"],
      ];
  for (const [open, close] of order) {
    const extracted = extractBalanced(content, open as string, close as string);
    if (extracted !== undefined) {
      return extracted;
    }
  }
  return content.trim();
}
