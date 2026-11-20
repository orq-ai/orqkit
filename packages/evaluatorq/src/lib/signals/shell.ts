import { pythonStrip } from "../common/sanitize.js";

const clis = new Set([
  "git",
  "orq",
  "gh",
  "uv",
  "docker",
  "kubectl",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "cargo",
  "go",
]);
function tokens(command: string): string[] | null {
  const out: string[] = [];
  let word = "",
    started = false,
    quote: string | null = null;
  const flush = () => {
    if (started) {
      out.push(word);
      word = "";
      started = false;
    }
  };
  for (let i = 0; i < command.length; i++) {
    const char = command.charAt(i);
    if (quote !== null) {
      if (char === quote) {
        quote = null;
        continue;
      }
      if (char === "\\" && quote === '"') {
        const next = command.charAt(++i);
        if (!next) return null;
        word += next === quote || next === "\\" ? next : `\\${next}`;
      } else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (char === "\\") {
      const next = command.charAt(++i);
      if (!next) return null;
      word += next;
      started = true;
      continue;
    }
    if (char === "#") {
      flush();
      while (i < command.length && command.charAt(i) !== "\n") i++;
      continue;
    }
    if (" \t\r\n".includes(char)) {
      flush();
      continue;
    }
    if (";&|".includes(char)) {
      flush();
      let punctuation = char;
      while (";&|".includes(command.charAt(i + 1)) && i + 1 < command.length)
        punctuation += command.charAt(++i);
      out.push(punctuation);
      continue;
    }
    word += char;
    started = true;
  }
  if (quote !== null) return null;
  flush();
  return out;
}
export function shellCommandFamily(command: unknown): string | null {
  if (typeof command !== "string" || !pythonStrip(command)) return null;
  const words = tokens(command);
  if (words === null) return null;
  while (words.length) {
    if (/^[A-Za-z_][A-Za-z_0-9]*=.*$/.test(words[0] ?? "")) words.shift();
    else if (
      words.length >= 3 &&
      words[0] === "cd" &&
      (words[2] === ";" || words[2] === "&&")
    )
      words.splice(0, 3);
    else break;
  }
  const first = words[0];
  if (first === undefined || [";", "&&", "||", "|"].includes(first))
    return null;
  const executable = first.split("/").at(-1) ?? "",
    next = words[1];
  return clis.has(executable) &&
    next !== undefined &&
    ![";", "&&", "||", "|"].includes(next) &&
    !next.startsWith("-")
    ? `${executable} ${next}`
    : executable;
}
