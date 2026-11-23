// Python's `\s`, which differs from JavaScript's on U+001C to U+001F, U+0085 and U+FEFF.
export const SPACE =
  "[\\t-\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";

const EDGE_SPACE = new RegExp(`^${SPACE}+|${SPACE}+$`, "g");
const SPACE_RUN = new RegExp(`${SPACE}+`);

/** `str.strip()`, which trims a different set of characters than `trim()`. */
export function pythonStrip(text: string): string {
  return text.replace(EDGE_SPACE, "");
}

/** `str.split()` with no separator. */
export function pythonSplit(text: string): string[] {
  return pythonStrip(text)
    .split(SPACE_RUN)
    .filter((token) => token !== "");
}

// Python's IGNORECASE also folds these non-ASCII letters onto ASCII ones.
const FOLDS: Readonly<Record<string, string>> = {
  i: "\\u0130\\u0131",
  k: "\\u212a",
  s: "\\u017f",
};

function caseless(tag: string): string {
  return [...tag]
    .map((char) => {
      const lower = char.toLowerCase();
      return lower === char.toUpperCase()
        ? char
        : `[${lower}${char.toUpperCase()}${FOLDS[lower] ?? ""}]`;
    })
    .join("");
}

const entities = (text: string): string =>
  text.replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Wraps untrusted text in `<tag>` boundaries that the text cannot break out of. */
export function delimit(text: string, options: { tag?: string } = {}): string {
  const tag = options.tag ?? "data";
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(tag)) {
    throw new Error(`Invalid tag name: '${tag}'`);
  }
  // The tag charset needs no escaping. Slash and no-slash alternatives stay
  // separate, and matches stop at another `<`, to avoid quadratic backtracking.
  const name = caseless(tag);
  const open = `<(?:${SPACE}*/${SPACE}*|${SPACE}*)${name}(?![a-zA-Z0-9_\\u0130\\u0131\\u212a\\u017f-])`;
  const sameCase = new RegExp(name);
  const sanitized = text
    .replaceAll("&", "&amp;")
    .replace(new RegExp(`${open}[^<>]*>`, "g"), (match) =>
      entities(match.replace(sameCase, tag)),
    )
    .replace(new RegExp(`${open}(?:[^<>]*<[^>]*(?:>|$))?`, "g"), entities);
  return `<${tag}>${sanitized}</${tag}>`;
}

export function xmlEscape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function codepointCompare(a: string, b: string): number {
  const left = Array.from(a, (c) => c.codePointAt(0) ?? 0),
    right = Array.from(b, (c) => c.codePointAt(0) ?? 0);
  for (let i = 0; i < Math.min(left.length, right.length); i++)
    if (left[i] !== right[i]) return (left[i] ?? 0) - (right[i] ?? 0);
  return left.length - right.length;
}

const CASE_FOLDS: Readonly<Record<string, string>> = {
  "\u00b5": "\u03bc",
  "\u00df": "ss",
  "\u0149": "\u02bcn",
  "\u017f": "s",
  "\u01f0": "j\u030c",
  "\u0345": "\u03b9",
  "\u0390": "\u03b9\u0308\u0301",
  "\u03b0": "\u03c5\u0308\u0301",
  "\u03c2": "\u03c3",
  "\u03d0": "\u03b2",
  "\u03d1": "\u03b8",
  "\u03d5": "\u03c6",
  "\u03d6": "\u03c0",
  "\u03f0": "\u03ba",
  "\u03f1": "\u03c1",
  "\u03f5": "\u03b5",
  "\u0587": "\u0565\u0582",
  "\u13a0": "\u13a0",
  "\u13a1": "\u13a1",
  "\u13a2": "\u13a2",
  "\u13a3": "\u13a3",
  "\u13a4": "\u13a4",
  "\u13a5": "\u13a5",
  "\u13a6": "\u13a6",
  "\u13a7": "\u13a7",
  "\u13a8": "\u13a8",
  "\u13a9": "\u13a9",
  "\u13aa": "\u13aa",
  "\u13ab": "\u13ab",
  "\u13ac": "\u13ac",
  "\u13ad": "\u13ad",
  "\u13ae": "\u13ae",
  "\u13af": "\u13af",
  "\u13b0": "\u13b0",
  "\u13b1": "\u13b1",
  "\u13b2": "\u13b2",
  "\u13b3": "\u13b3",
  "\u13b4": "\u13b4",
  "\u13b5": "\u13b5",
  "\u13b6": "\u13b6",
  "\u13b7": "\u13b7",
  "\u13b8": "\u13b8",
  "\u13b9": "\u13b9",
  "\u13ba": "\u13ba",
  "\u13bb": "\u13bb",
  "\u13bc": "\u13bc",
  "\u13bd": "\u13bd",
  "\u13be": "\u13be",
  "\u13bf": "\u13bf",
  "\u13c0": "\u13c0",
  "\u13c1": "\u13c1",
  "\u13c2": "\u13c2",
  "\u13c3": "\u13c3",
  "\u13c4": "\u13c4",
  "\u13c5": "\u13c5",
  "\u13c6": "\u13c6",
  "\u13c7": "\u13c7",
  "\u13c8": "\u13c8",
  "\u13c9": "\u13c9",
  "\u13ca": "\u13ca",
  "\u13cb": "\u13cb",
  "\u13cc": "\u13cc",
  "\u13cd": "\u13cd",
  "\u13ce": "\u13ce",
  "\u13cf": "\u13cf",
  "\u13d0": "\u13d0",
  "\u13d1": "\u13d1",
  "\u13d2": "\u13d2",
  "\u13d3": "\u13d3",
  "\u13d4": "\u13d4",
  "\u13d5": "\u13d5",
  "\u13d6": "\u13d6",
  "\u13d7": "\u13d7",
  "\u13d8": "\u13d8",
  "\u13d9": "\u13d9",
  "\u13da": "\u13da",
  "\u13db": "\u13db",
  "\u13dc": "\u13dc",
  "\u13dd": "\u13dd",
  "\u13de": "\u13de",
  "\u13df": "\u13df",
  "\u13e0": "\u13e0",
  "\u13e1": "\u13e1",
  "\u13e2": "\u13e2",
  "\u13e3": "\u13e3",
  "\u13e4": "\u13e4",
  "\u13e5": "\u13e5",
  "\u13e6": "\u13e6",
  "\u13e7": "\u13e7",
  "\u13e8": "\u13e8",
  "\u13e9": "\u13e9",
  "\u13ea": "\u13ea",
  "\u13eb": "\u13eb",
  "\u13ec": "\u13ec",
  "\u13ed": "\u13ed",
  "\u13ee": "\u13ee",
  "\u13ef": "\u13ef",
  "\u13f0": "\u13f0",
  "\u13f1": "\u13f1",
  "\u13f2": "\u13f2",
  "\u13f3": "\u13f3",
  "\u13f4": "\u13f4",
  "\u13f5": "\u13f5",
  "\u13f8": "\u13f0",
  "\u13f9": "\u13f1",
  "\u13fa": "\u13f2",
  "\u13fb": "\u13f3",
  "\u13fc": "\u13f4",
  "\u13fd": "\u13f5",
  "\u1c80": "\u0432",
  "\u1c81": "\u0434",
  "\u1c82": "\u043e",
  "\u1c83": "\u0441",
  "\u1c84": "\u0442",
  "\u1c85": "\u0442",
  "\u1c86": "\u044a",
  "\u1c87": "\u0463",
  "\u1c88": "\ua64b",
  "\u1e96": "h\u0331",
  "\u1e97": "t\u0308",
  "\u1e98": "w\u030a",
  "\u1e99": "y\u030a",
  "\u1e9a": "a\u02be",
  "\u1e9b": "\u1e61",
  "\u1e9e": "ss",
  "\u1f50": "\u03c5\u0313",
  "\u1f52": "\u03c5\u0313\u0300",
  "\u1f54": "\u03c5\u0313\u0301",
  "\u1f56": "\u03c5\u0313\u0342",
  "\u1f80": "\u1f00\u03b9",
  "\u1f81": "\u1f01\u03b9",
  "\u1f82": "\u1f02\u03b9",
  "\u1f83": "\u1f03\u03b9",
  "\u1f84": "\u1f04\u03b9",
  "\u1f85": "\u1f05\u03b9",
  "\u1f86": "\u1f06\u03b9",
  "\u1f87": "\u1f07\u03b9",
  "\u1f88": "\u1f00\u03b9",
  "\u1f89": "\u1f01\u03b9",
  "\u1f8a": "\u1f02\u03b9",
  "\u1f8b": "\u1f03\u03b9",
  "\u1f8c": "\u1f04\u03b9",
  "\u1f8d": "\u1f05\u03b9",
  "\u1f8e": "\u1f06\u03b9",
  "\u1f8f": "\u1f07\u03b9",
  "\u1f90": "\u1f20\u03b9",
  "\u1f91": "\u1f21\u03b9",
  "\u1f92": "\u1f22\u03b9",
  "\u1f93": "\u1f23\u03b9",
  "\u1f94": "\u1f24\u03b9",
  "\u1f95": "\u1f25\u03b9",
  "\u1f96": "\u1f26\u03b9",
  "\u1f97": "\u1f27\u03b9",
  "\u1f98": "\u1f20\u03b9",
  "\u1f99": "\u1f21\u03b9",
  "\u1f9a": "\u1f22\u03b9",
  "\u1f9b": "\u1f23\u03b9",
  "\u1f9c": "\u1f24\u03b9",
  "\u1f9d": "\u1f25\u03b9",
  "\u1f9e": "\u1f26\u03b9",
  "\u1f9f": "\u1f27\u03b9",
  "\u1fa0": "\u1f60\u03b9",
  "\u1fa1": "\u1f61\u03b9",
  "\u1fa2": "\u1f62\u03b9",
  "\u1fa3": "\u1f63\u03b9",
  "\u1fa4": "\u1f64\u03b9",
  "\u1fa5": "\u1f65\u03b9",
  "\u1fa6": "\u1f66\u03b9",
  "\u1fa7": "\u1f67\u03b9",
  "\u1fa8": "\u1f60\u03b9",
  "\u1fa9": "\u1f61\u03b9",
  "\u1faa": "\u1f62\u03b9",
  "\u1fab": "\u1f63\u03b9",
  "\u1fac": "\u1f64\u03b9",
  "\u1fad": "\u1f65\u03b9",
  "\u1fae": "\u1f66\u03b9",
  "\u1faf": "\u1f67\u03b9",
  "\u1fb2": "\u1f70\u03b9",
  "\u1fb3": "\u03b1\u03b9",
  "\u1fb4": "\u03ac\u03b9",
  "\u1fb6": "\u03b1\u0342",
  "\u1fb7": "\u03b1\u0342\u03b9",
  "\u1fbc": "\u03b1\u03b9",
  "\u1fbe": "\u03b9",
  "\u1fc2": "\u1f74\u03b9",
  "\u1fc3": "\u03b7\u03b9",
  "\u1fc4": "\u03ae\u03b9",
  "\u1fc6": "\u03b7\u0342",
  "\u1fc7": "\u03b7\u0342\u03b9",
  "\u1fcc": "\u03b7\u03b9",
  "\u1fd2": "\u03b9\u0308\u0300",
  "\u1fd3": "\u03b9\u0308\u0301",
  "\u1fd6": "\u03b9\u0342",
  "\u1fd7": "\u03b9\u0308\u0342",
  "\u1fe2": "\u03c5\u0308\u0300",
  "\u1fe3": "\u03c5\u0308\u0301",
  "\u1fe4": "\u03c1\u0313",
  "\u1fe6": "\u03c5\u0342",
  "\u1fe7": "\u03c5\u0308\u0342",
  "\u1ff2": "\u1f7c\u03b9",
  "\u1ff3": "\u03c9\u03b9",
  "\u1ff4": "\u03ce\u03b9",
  "\u1ff6": "\u03c9\u0342",
  "\u1ff7": "\u03c9\u0342\u03b9",
  "\u1ffc": "\u03c9\u03b9",
  "\uab70": "\u13a0",
  "\uab71": "\u13a1",
  "\uab72": "\u13a2",
  "\uab73": "\u13a3",
  "\uab74": "\u13a4",
  "\uab75": "\u13a5",
  "\uab76": "\u13a6",
  "\uab77": "\u13a7",
  "\uab78": "\u13a8",
  "\uab79": "\u13a9",
  "\uab7a": "\u13aa",
  "\uab7b": "\u13ab",
  "\uab7c": "\u13ac",
  "\uab7d": "\u13ad",
  "\uab7e": "\u13ae",
  "\uab7f": "\u13af",
  "\uab80": "\u13b0",
  "\uab81": "\u13b1",
  "\uab82": "\u13b2",
  "\uab83": "\u13b3",
  "\uab84": "\u13b4",
  "\uab85": "\u13b5",
  "\uab86": "\u13b6",
  "\uab87": "\u13b7",
  "\uab88": "\u13b8",
  "\uab89": "\u13b9",
  "\uab8a": "\u13ba",
  "\uab8b": "\u13bb",
  "\uab8c": "\u13bc",
  "\uab8d": "\u13bd",
  "\uab8e": "\u13be",
  "\uab8f": "\u13bf",
  "\uab90": "\u13c0",
  "\uab91": "\u13c1",
  "\uab92": "\u13c2",
  "\uab93": "\u13c3",
  "\uab94": "\u13c4",
  "\uab95": "\u13c5",
  "\uab96": "\u13c6",
  "\uab97": "\u13c7",
  "\uab98": "\u13c8",
  "\uab99": "\u13c9",
  "\uab9a": "\u13ca",
  "\uab9b": "\u13cb",
  "\uab9c": "\u13cc",
  "\uab9d": "\u13cd",
  "\uab9e": "\u13ce",
  "\uab9f": "\u13cf",
  "\uaba0": "\u13d0",
  "\uaba1": "\u13d1",
  "\uaba2": "\u13d2",
  "\uaba3": "\u13d3",
  "\uaba4": "\u13d4",
  "\uaba5": "\u13d5",
  "\uaba6": "\u13d6",
  "\uaba7": "\u13d7",
  "\uaba8": "\u13d8",
  "\uaba9": "\u13d9",
  "\uabaa": "\u13da",
  "\uabab": "\u13db",
  "\uabac": "\u13dc",
  "\uabad": "\u13dd",
  "\uabae": "\u13de",
  "\uabaf": "\u13df",
  "\uabb0": "\u13e0",
  "\uabb1": "\u13e1",
  "\uabb2": "\u13e2",
  "\uabb3": "\u13e3",
  "\uabb4": "\u13e4",
  "\uabb5": "\u13e5",
  "\uabb6": "\u13e6",
  "\uabb7": "\u13e7",
  "\uabb8": "\u13e8",
  "\uabb9": "\u13e9",
  "\uabba": "\u13ea",
  "\uabbb": "\u13eb",
  "\uabbc": "\u13ec",
  "\uabbd": "\u13ed",
  "\uabbe": "\u13ee",
  "\uabbf": "\u13ef",
  "\ufb00": "ff",
  "\ufb01": "fi",
  "\ufb02": "fl",
  "\ufb03": "ffi",
  "\ufb04": "ffl",
  "\ufb05": "st",
  "\ufb06": "st",
  "\ufb13": "\u0574\u0576",
  "\ufb14": "\u0574\u0565",
  "\ufb15": "\u0574\u056b",
  "\ufb16": "\u057e\u0576",
  "\ufb17": "\u0574\u056d",
};

export function pythonCasefold(text: string): string {
  return Array.from(
    text,
    (char) => CASE_FOLDS[char] ?? char.toLowerCase(),
  ).join("");
}

const TITLE_CASE: Readonly<Record<string, string>> = {
  "\u00df": "Ss",
  "\u01c4": "\u01c5",
  "\u01c5": "\u01c5",
  "\u01c6": "\u01c5",
  "\u01c7": "\u01c8",
  "\u01c8": "\u01c8",
  "\u01c9": "\u01c8",
  "\u01ca": "\u01cb",
  "\u01cb": "\u01cb",
  "\u01cc": "\u01cb",
  "\u01f1": "\u01f2",
  "\u01f2": "\u01f2",
  "\u01f3": "\u01f2",
  "\u0587": "\u0535\u0582",
  "\u10d0": "\u10d0",
  "\u10d1": "\u10d1",
  "\u10d2": "\u10d2",
  "\u10d3": "\u10d3",
  "\u10d4": "\u10d4",
  "\u10d5": "\u10d5",
  "\u10d6": "\u10d6",
  "\u10d7": "\u10d7",
  "\u10d8": "\u10d8",
  "\u10d9": "\u10d9",
  "\u10da": "\u10da",
  "\u10db": "\u10db",
  "\u10dc": "\u10dc",
  "\u10dd": "\u10dd",
  "\u10de": "\u10de",
  "\u10df": "\u10df",
  "\u10e0": "\u10e0",
  "\u10e1": "\u10e1",
  "\u10e2": "\u10e2",
  "\u10e3": "\u10e3",
  "\u10e4": "\u10e4",
  "\u10e5": "\u10e5",
  "\u10e6": "\u10e6",
  "\u10e7": "\u10e7",
  "\u10e8": "\u10e8",
  "\u10e9": "\u10e9",
  "\u10ea": "\u10ea",
  "\u10eb": "\u10eb",
  "\u10ec": "\u10ec",
  "\u10ed": "\u10ed",
  "\u10ee": "\u10ee",
  "\u10ef": "\u10ef",
  "\u10f0": "\u10f0",
  "\u10f1": "\u10f1",
  "\u10f2": "\u10f2",
  "\u10f3": "\u10f3",
  "\u10f4": "\u10f4",
  "\u10f5": "\u10f5",
  "\u10f6": "\u10f6",
  "\u10f7": "\u10f7",
  "\u10f8": "\u10f8",
  "\u10f9": "\u10f9",
  "\u10fa": "\u10fa",
  "\u10fd": "\u10fd",
  "\u10fe": "\u10fe",
  "\u10ff": "\u10ff",
  "\u1f80": "\u1f88",
  "\u1f81": "\u1f89",
  "\u1f82": "\u1f8a",
  "\u1f83": "\u1f8b",
  "\u1f84": "\u1f8c",
  "\u1f85": "\u1f8d",
  "\u1f86": "\u1f8e",
  "\u1f87": "\u1f8f",
  "\u1f88": "\u1f88",
  "\u1f89": "\u1f89",
  "\u1f8a": "\u1f8a",
  "\u1f8b": "\u1f8b",
  "\u1f8c": "\u1f8c",
  "\u1f8d": "\u1f8d",
  "\u1f8e": "\u1f8e",
  "\u1f8f": "\u1f8f",
  "\u1f90": "\u1f98",
  "\u1f91": "\u1f99",
  "\u1f92": "\u1f9a",
  "\u1f93": "\u1f9b",
  "\u1f94": "\u1f9c",
  "\u1f95": "\u1f9d",
  "\u1f96": "\u1f9e",
  "\u1f97": "\u1f9f",
  "\u1f98": "\u1f98",
  "\u1f99": "\u1f99",
  "\u1f9a": "\u1f9a",
  "\u1f9b": "\u1f9b",
  "\u1f9c": "\u1f9c",
  "\u1f9d": "\u1f9d",
  "\u1f9e": "\u1f9e",
  "\u1f9f": "\u1f9f",
  "\u1fa0": "\u1fa8",
  "\u1fa1": "\u1fa9",
  "\u1fa2": "\u1faa",
  "\u1fa3": "\u1fab",
  "\u1fa4": "\u1fac",
  "\u1fa5": "\u1fad",
  "\u1fa6": "\u1fae",
  "\u1fa7": "\u1faf",
  "\u1fa8": "\u1fa8",
  "\u1fa9": "\u1fa9",
  "\u1faa": "\u1faa",
  "\u1fab": "\u1fab",
  "\u1fac": "\u1fac",
  "\u1fad": "\u1fad",
  "\u1fae": "\u1fae",
  "\u1faf": "\u1faf",
  "\u1fb2": "\u1fba\u0345",
  "\u1fb3": "\u1fbc",
  "\u1fb4": "\u0386\u0345",
  "\u1fb7": "\u0391\u0342\u0345",
  "\u1fbc": "\u1fbc",
  "\u1fc2": "\u1fca\u0345",
  "\u1fc3": "\u1fcc",
  "\u1fc4": "\u0389\u0345",
  "\u1fc7": "\u0397\u0342\u0345",
  "\u1fcc": "\u1fcc",
  "\u1ff2": "\u1ffa\u0345",
  "\u1ff3": "\u1ffc",
  "\u1ff4": "\u038f\u0345",
  "\u1ff7": "\u03a9\u0342\u0345",
  "\u1ffc": "\u1ffc",
  "\ufb00": "Ff",
  "\ufb01": "Fi",
  "\ufb02": "Fl",
  "\ufb03": "Ffi",
  "\ufb04": "Ffl",
  "\ufb05": "St",
  "\ufb06": "St",
  "\ufb13": "\u0544\u0576",
  "\ufb14": "\u0544\u0565",
  "\ufb15": "\u0544\u056b",
  "\ufb16": "\u054e\u0576",
  "\ufb17": "\u0544\u056d",
};
export function pythonTitle(text: string): string {
  let previousCased = false;
  return Array.from(text, (char) => {
    const lower = char.toLowerCase(),
      upper = char.toUpperCase();
    const out = previousCased ? lower : (TITLE_CASE[char] ?? upper);
    previousCased = lower !== upper;
    return out;
  }).join("");
}

export function pythonString(value: unknown): string {
  if (value == null) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number" && !Number.isFinite(value))
    return Number.isNaN(value) ? "nan" : value > 0 ? "inf" : "-inf";
  if (Array.isArray(value)) return `[${value.map(pythonRepr).join(", ")}]`;
  if (typeof value === "object")
    return `{${Object.entries(value)
      .map(([key, item]) => `${pythonRepr(key)}: ${pythonRepr(item)}`)
      .join(", ")}}`;
  return String(value);
}
function pythonRepr(value: unknown): string {
  if (typeof value !== "string") return pythonString(value);
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  return (
    quote +
    value
      .replaceAll("\\", "\\\\")
      .replaceAll(quote, `\\${quote}`)
      .replaceAll("\n", "\\n")
      .replaceAll("\r", "\\r")
      .replaceAll("\t", "\\t") +
    quote
  );
}
