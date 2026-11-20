const WORD = String.raw`[\p{L}\p{N}_]`;
const WORD_START = `(?<!${WORD})`;
const WORD_END = `(?!${WORD})`;
const PLACEHOLDED = "(?!<[A-Z_]+>)";

export function normalizePlaceholders(text: string): string {
  return text.replace(/<([A-Z][A-Z0-9_]*)_\d+>/g, "<$1>");
}

type Replacer = (match: string, ...groups: string[]) => string;

interface Rule {
  pattern: RegExp;
  replace: Replacer;
}

const mask =
  (label: string): Replacer =>
  () =>
    `<${label}>`;

// Every masked group ends its pattern, so the kept label is whatever precedes it.
const maskLastGroup =
  (label: string, group = 1): Replacer =>
  (match, ...groups) =>
    `${match.slice(0, match.length - (groups[group - 1] as string).length)}<${label}>`;

function entropyOk(rawToken: string): boolean {
  const token = rawToken.replace(/^=+|=+$/g, "");
  if (!token || /^[0-9a-f]+$/.test(token)) {
    return false;
  }
  if (token.split(/[-_/.+]/).some((part) => /^[a-z]{4,}$/.test(part))) {
    return false;
  }
  const runs = token.match(/[A-Z]+|[a-z]+|[0-9]+|[^A-Za-z0-9]+/g) ?? [];
  if (token.length / runs.length >= 2.5) {
    return false;
  }
  if (!(/[A-Z]/.test(token) && /[a-z]/.test(token) && /[0-9]/.test(token))) {
    return false;
  }
  const counts = new Map<string, number>();
  for (const character of token) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    entropy -= (count / token.length) * Math.log2(count / token.length);
  }
  return entropy >= 3.8;
}

function maskEntropy(token: string): string {
  const trimmed = token.replace(/=+$/, "");
  const name = trimmed.slice(0, Math.max(0, trimmed.lastIndexOf("=")));
  const prefix = name ? token.slice(0, name.length + 1) : "";
  const value = token.slice(prefix.length);
  return value.length >= 20 && entropyOk(value) ? `${prefix}<SECRET>` : token;
}

// Order matters: structural rules first, the generic and entropy rules last.
const RULES: readonly Rule[] = [
  {
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/gsu,
    replace: mask("PRIVATE_KEY"),
  },
  {
    pattern:
      /(?:(?:(?<![^\n])|\\n|\n)[A-Za-z0-9+/]{60,76}={0,2}(?=\\n|(?![^\n]))){2,}/gu,
    replace: mask("PRIVATE_KEY"),
  },
  {
    pattern: /(?<=:\/\/)[^\s/:@'"]*:[^\s/@'"]+(?=@)/gu,
    replace: mask("CREDENTIALS"),
  },
  {
    pattern:
      /https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9_/-]+/gu,
    replace: mask("WEBHOOK_URL"),
  },
  {
    pattern: new RegExp(
      `${WORD_START}(?:(?:AKIA|ASIA)[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|[rs]k_(?:live|test)_[A-Za-z0-9]{16,}|sk-(?:proj-|ant-[a-z0-9]+-)?[A-Za-z0-9_-]{16,}|hf_[A-Za-z0-9]{30,}|npm_[A-Za-z0-9]{36}|pypi-[A-Za-z0-9_-]{50,})`,
      "gu",
    ),
    replace: mask("API_KEY"),
  },
  {
    pattern: new RegExp(
      `${WORD_START}eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}`,
      "gu",
    ),
    replace: mask("JWT"),
  },
  {
    // The value must hold a digit, so prose such as `Bearer token expired` stays.
    pattern: new RegExp(
      `(${WORD_START}(?:Bearer|Basic|Authorization:\\s*Token)\\s+)${PLACEHOLDED}(?=[^\\s'"]*\\d)([A-Za-z0-9._~+/=-]{8,})`,
      "giu",
    ),
    replace: maskLastGroup("SECRET", 2),
  },
  {
    pattern: new RegExp(
      `(${WORD_START}(?:mysql|mysqldump|mysqladmin|mariadb)${WORD_END}[^\\n|;&]*?\\s-p)([^\\s'"]+)`,
      "gu",
    ),
    replace: maskLastGroup("PASSWORD", 2),
  },
  {
    pattern: new RegExp(
      `(?<!\\S)--?(?:password|passwd|pass|pwd|secret|token|api[-_]?key|auth[-_]?token)(?:=|\\s+)${PLACEHOLDED}([^\\s'"]+)`,
      "giu",
    ),
    replace: maskLastGroup("PASSWORD"),
  },
  {
    pattern: new RegExp(
      `(?<![A-Z0-9_.-])[A-Z0-9_.-]*(?:pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?|accountkey|session(?:id)?|cookie|sid)[A-Z0-9_.-]*["']?\\s*[=:]\\s*["']?${PLACEHOLDED}([^\\s"',;\\\\]{6,})`,
      "giu",
    ),
    replace: maskLastGroup("SECRET"),
  },
  {
    pattern: new RegExp(
      `(?<![:\\p{L}\\p{N}_])[0-9a-fA-F]{64,}${WORD_END}`,
      "gu",
    ),
    replace: mask("SECRET"),
  },
  { pattern: /[A-Za-z0-9+/_=-]{20,}/gu, replace: maskEntropy },
];

export function scrubKnownSecrets(text: string): string {
  let scrubbed = text;
  for (const { pattern, replace } of RULES) {
    scrubbed = scrubbed.replace(pattern, replace);
  }
  return scrubbed;
}
