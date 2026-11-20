import { SPACE } from "../common/sanitize.js";

function withoutComments(pattern: string): string {
  let out = "",
    inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern.charAt(i);
    if (char === "\\") {
      out += pattern.slice(i, i + 2);
      i++;
      continue;
    }
    if (char === "[") inClass = true;
    if (char === "]") inClass = false;
    if (!inClass && char === "#") {
      while (i < pattern.length && pattern.charAt(i) !== "\n") i++;
      continue;
    }
    if (!inClass && " \t\n\r\f\v".includes(char)) continue;
    out += char;
  }
  return out;
}
function compile(pattern: string): RegExp {
  let ignoreCase = false,
    multiline = false,
    dotAll = false,
    ascii = false,
    verbose = false;
  for (;;) {
    const flags = /^\(\?([aiLmsux]+)\)/.exec(pattern);
    if (!flags) break;
    for (const flag of flags[1] ?? "") {
      if (flag === "L")
        throw new SyntaxError("LOCALE flag is invalid for a string pattern");
      if (flag === "i") ignoreCase = true;
      if (flag === "m") multiline = true;
      if (flag === "s") dotAll = true;
      if (flag === "a") ascii = true;
      if (flag === "x") verbose = true;
    }
    pattern = pattern.slice(flags[0].length);
    if (verbose) pattern = withoutComments(pattern);
  }
  const word = ascii ? "A-Za-z0-9_" : "\\p{L}\\p{N}_",
    space = ascii ? "[ \\t\\n\\r\\f\\v]" : SPACE,
    digit = ascii ? "0-9" : "\\p{Nd}",
    category: Record<string, string> = {
      w: `[${word}]`,
      W: `[^${word}]`,
      d: `[${digit}]`,
      D: `[^${digit}]`,
      s: space,
      S: `[^${space.slice(1, -1)}]`,
    };
  let out = "";
  const readEscape = (index: number, inClass = false): [string, number] => {
    const next = pattern.charAt(index + 1);
    if (!next) throw new SyntaxError("Pattern ends in an escape");
    if (Object.hasOwn(category, next))
      return [category[next] as string, index + 1];
    if (next === "p" || next === "P")
      throw new SyntaxError(
        "Python patterns do not define a Unicode property escape",
      );
    if (next === "U") {
      const hex = pattern.slice(index + 2, index + 10);
      if (!/^[0-9a-f]{8}$/i.test(hex))
        throw new SyntaxError("Invalid Unicode escape");
      return [`\\u{${Number.parseInt(hex, 16).toString(16)}}`, index + 9];
    }
    if (next === "a") return ["\\x07", index + 1];
    if (!inClass && next === "A") return ["(?<![\\s\\S])", index + 1];
    if (!inClass && next === "Z") return ["(?![\\s\\S])", index + 1];
    if (!inClass && next === "-") return ["-", index + 1];
    if (!inClass && next === "k")
      throw new SyntaxError(
        "Python patterns do not define a named k backreference",
      );
    if (!inClass && next === "b")
      return [
        `(?:(?<=[${word}])(?![${word}])|(?<![${word}])(?=[${word}]))`,
        index + 1,
      ];
    if (!inClass && next === "B")
      return [
        `(?!(?<![\\s\\S])(?![\\s\\S]))(?:(?<=[${word}])(?=[${word}])|(?<![${word}])(?![${word}]))`,
        index + 1,
      ];
    const octal =
      next === "0"
        ? /^[0-7]{1,3}/.exec(pattern.slice(index + 1))
        : /^[0-7]{3}/.exec(pattern.slice(index + 1));
    if (octal)
      return [
        `\\u{${Number.parseInt(octal[0], 8).toString(16)}}`,
        index + octal[0].length,
      ];
    if (!/[A-Za-z0-9]/.test(next) && !"^$\\.*+?()[]{}|/-".includes(next))
      return [`\\u{${next.codePointAt(0)?.toString(16)}}`, index + 1];
    return [pattern.slice(index, index + 2), index + 1];
  };
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern.charAt(i);
    if (char === "\\") {
      const [part, end] = readEscape(i);
      out += part;
      i = end;
      continue;
    }
    if (char === "[") {
      let index = i + 1,
        negated = false,
        ordinary = "";
      const alternatives: string[] = [];
      if (pattern.charAt(index) === "^") {
        negated = true;
        index++;
      }
      const first = index;
      for (; index < pattern.length; index++) {
        const c = pattern.charAt(index);
        if (c === "]" && index !== first) break;
        if (c === "]" && index === first) {
          ordinary += "\\]";
          continue;
        }
        if (c === "\\") {
          const next = pattern.charAt(index + 1),
            [part, end] = readEscape(index, true);
          if (/[dDwWsS]/.test(next)) {
            if (
              (pattern.charAt(end + 1) === "-" &&
                pattern.charAt(end + 2) !== "]") ||
              (index > first + 1 && pattern.charAt(index - 1) === "-")
            )
              throw new SyntaxError("Invalid character-class range");
            if (next === next.toUpperCase()) alternatives.push(part);
            else ordinary += part.slice(1, -1);
          } else ordinary += part;
          index = end;
        } else if (
          c === "-" &&
          (index === first || pattern.charAt(index + 1) === "]")
        )
          ordinary += "\\-";
        else ordinary += c;
      }
      if (index === pattern.length)
        throw new SyntaxError("Unterminated character class");
      if (ignoreCase && ordinary) {
        const base = new RegExp(`[${ordinary}]`, "u");
        if (ascii) {
          for (const lower of "abcdefghijklmnopqrstuvwxyz") {
            const upper = lower.toUpperCase();
            if (base.test(lower) || base.test(upper)) ordinary += lower + upper;
          }
        } else {
          const folded = new RegExp(`[${ordinary}]`, "iu");
          if (folded.test("I")) ordinary += "\\u0130\\u0131";
          if (folded.test("K")) ordinary += "\\u212a";
          if (folded.test("S")) ordinary += "\\u017f";
        }
      }
      if (!alternatives.length) out += `[${negated ? "^" : ""}${ordinary}]`;
      else {
        if (ordinary) alternatives.unshift(`[${ordinary}]`);
        const union = `(?:${alternatives.join("|")})`;
        out += negated ? `(?!${union})[\\s\\S]` : union;
      }
      i = index;
      continue;
    }
    if (pattern.startsWith("(?#", i)) {
      const close = pattern.indexOf(")", i + 3);
      if (close < 0) throw new SyntaxError("Unterminated pattern comment");
      i = close;
      continue;
    }
    if (pattern.startsWith("(?P<", i)) {
      const close = pattern.indexOf(">", i + 4);
      if (close < 0) throw new SyntaxError("Unterminated named group");
      out += `(?<${pattern.slice(i + 4, close)}>`;
      i = close;
      continue;
    }
    if (
      pattern.startsWith("(?<", i) &&
      !["=", "!"].includes(pattern.charAt(i + 3))
    )
      throw new SyntaxError("Python named groups use P syntax");
    if (pattern.startsWith("(?P=", i)) {
      const close = pattern.indexOf(")", i + 4);
      if (close < 0) throw new SyntaxError("Unterminated named backreference");
      out += `\\k<${pattern.slice(i + 4, close)}>`;
      i = close;
      continue;
    }
    if (char === ".") out += dotAll ? "[\\s\\S]" : "[^\\n]";
    else if (char === "^")
      out += multiline ? "(?:(?<![\\s\\S])|(?<=\\n))" : "^";
    else if (char === "$")
      out += multiline ? "(?=\\n|(?![\\s\\S]))" : "(?=\\n?(?![\\s\\S]))";
    else if (char === "{") {
      const quantifier = /^\{(\d*),(\d*)\}|^\{\d+\}/.exec(pattern.slice(i));
      if (quantifier) {
        out += quantifier[0].startsWith("{,")
          ? quantifier[0].replace("{,", "{0,")
          : quantifier[0];
        i += quantifier[0].length - 1;
      } else out += "\\{";
    } else if (char === "}" || char === "]") out += `\\${char}`;
    else if (ignoreCase && !ascii && ["i", "I", "ı", "İ"].includes(char))
      out += "[Ii\\u0130\\u0131]";
    else if (ignoreCase && ascii && /[A-Za-z]/.test(char))
      out += `[${char.toLowerCase()}${char.toUpperCase()}]`;
    else out += char;
  }
  return new RegExp(out, ignoreCase && !ascii ? "iu" : "u");
}
export const pythonRegexEngine = Object.assign(
  (pattern: string, _flags?: string): RegExp => compile(pattern),
  { code: "pythonRegexEngine" },
);
