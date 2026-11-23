import { scrubKnownSecrets } from "../common/redact.js";

export const MIN_REPEATED_LINES = 3;
export const MIN_REFERENCED_RESULT_CHARS = 40;
export const BASE64_RUN_CHARS = 200;
export const HEX_RUN_CHARS = 64;
export const MIN_BLOB_DISTINCT_CHARS = 8;

const ANSI =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escapes is the point
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const BASE64_RUN = new RegExp(`[A-Za-z0-9+/=]{${BASE64_RUN_CHARS},}`, "g");
const HEX_RUN = new RegExp(`[0-9a-fA-F]{${HEX_RUN_CHARS},}`, "g");
const CWD_KEYS = ["cwd", "workdir", "working_directory"];

export const READABLE_STYLE_FLAGS = [
  "blocks",
  "pair_results",
  "plain_tool_input",
  "labelled_cuts",
  "strip_terminal_noise",
  "shorten_cwd",
  "collapse_repeats",
  "collapse_blobs",
] as const;
export type ReadableStyleFlag = (typeof READABLE_STYLE_FLAGS)[number];

/** Opt-in layouts and reductions for the readable view; every flag off is the legacy layout. */
export class ReadableStyle {
  readonly blocks: boolean;
  readonly pair_results: boolean;
  readonly plain_tool_input: boolean;
  readonly labelled_cuts: boolean;
  readonly strip_terminal_noise: boolean;
  readonly shorten_cwd: boolean;
  readonly collapse_repeats: boolean;
  readonly collapse_blobs: boolean;

  constructor(flags: Partial<Record<ReadableStyleFlag, boolean>> = {}) {
    this.blocks = flags.blocks ?? false;
    this.pair_results = flags.pair_results ?? false;
    this.plain_tool_input = flags.plain_tool_input ?? false;
    this.labelled_cuts = flags.labelled_cuts ?? false;
    this.strip_terminal_noise = flags.strip_terminal_noise ?? false;
    this.shorten_cwd = flags.shorten_cwd ?? false;
    this.collapse_repeats = flags.collapse_repeats ?? false;
    this.collapse_blobs = flags.collapse_blobs ?? false;
    Object.freeze(this);
  }

  formatNotes(): string[] {
    return (
      [
        ["a header line per message with an indented body", this.blocks],
        ["results paired with calls", this.pair_results && this.blocks],
        ["tool inputs as key: value lines", this.plain_tool_input],
        ["cut markers name what was cut", this.labelled_cuts],
      ] as const
    )
      .filter(([, on]) => on)
      .map(([note]) => note);
  }

  reductionNotes(): string[] {
    return (
      [
        ["ANSI/progress noise", this.strip_terminal_noise],
        [
          "recorded working directory shown as ./ when unambiguous",
          this.shorten_cwd,
        ],
        ["repeated calls and results", this.collapse_repeats],
        ["encoded blobs", this.collapse_blobs],
      ] as const
    )
      .filter(([, on]) => on)
      .map(([note]) => note);
  }
}

/** Reductions for one tool input or result, split around secret scrubbing. */
export class TextReducer {
  constructor(
    readonly noise = false,
    readonly blobs = false,
    readonly cwd: string | null = null,
  ) {}

  static forStyle(
    style: ReadableStyle,
    cwd: string | null,
  ): TextReducer | null {
    const reducer = new TextReducer(
      style.strip_terminal_noise,
      style.collapse_blobs,
      style.shorten_cwd ? cwd : null,
    );
    return reducer.noise || reducer.blobs || reducer.cwd ? reducer : null;
  }

  beforeScrub(text: string): string {
    return this.noise ? stripAnsiAndRedraws(text) : text;
  }

  afterScrub(text: string): string {
    let out = text;
    if (this.noise) out = collapseRepeatedLines(out);
    if (this.blobs) out = collapseBlobs(out);
    if (this.cwd) out = shortenCwd(out, this.cwd);
    return out;
  }
}

export function stripAnsiAndRedraws(text: string): string {
  const clean = text.replace(ANSI, "").replaceAll("\r\n", "\n");
  if (!clean.includes("\r")) return clean;
  return clean
    .split("\n")
    .map((line) =>
      line.includes("\r")
        ? ([...line.split("\r")].reverse().find((part) => part) ?? "")
        : line,
    )
    .join("\n");
}

export function collapseRepeatedLines(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  let position = 0;
  while (position < lines.length) {
    let end = position + 1;
    while (end < lines.length && lines[end] === lines[position]) end++;
    const line = lines[position] as string;
    kept.push(line);
    if (line.trim() && end - position >= MIN_REPEATED_LINES)
      kept.push(`(repeated ${end - position} times)`);
    else kept.push(...lines.slice(position + 1, end));
    position = end;
  }
  return kept.join("\n");
}

export function collapseBlobs(text: string): string {
  const replace = (run: string) =>
    new Set(run).size >= MIN_BLOB_DISTINCT_CHARS
      ? `[blob, ${run.length} chars]`
      : run;
  return text.replace(BASE64_RUN, replace).replace(HEX_RUN, replace);
}

function normalizePosix(value: string): string {
  const parts = value.split("/").filter((p) => p && p !== ".");
  return `/${parts.join("/")}`;
}

export function detectWorkingDirectory(
  args: Iterable<string>,
  options: { recorded?: Iterable<string> } = {},
): string | null {
  const evidence = [...(options.recorded ?? [])];
  for (const raw of args) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(scrubKnownSecrets(raw));
    } catch {
      continue;
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      for (const key of CWD_KEYS) {
        const value = obj[key];
        if (typeof value === "string") evidence.push(value);
      }
    }
  }
  const directories = new Set<string>();
  for (const rawValue of evidence) {
    const value = scrubKnownSecrets(rawValue);
    const path = normalizePosix(value);
    if (
      !value.startsWith("/") ||
      value.startsWith("//") ||
      path === "/" ||
      value.split("/").includes("..") ||
      /[\r\n\t<>]/.test(value)
    )
      return null;
    directories.add(path);
  }
  return directories.size === 1 ? ([...directories][0] as string) : null;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

export function shortenCwd(text: string, cwd: string): string {
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_.~/@+-])${escapeRegex(cwd)}(/|(?![\\p{L}\\p{N}_.@+-]))`,
    "gu",
  );
  return text.replace(pattern, (_m, slash: string) => (slash ? "./" : "."));
}

export function plainArguments(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return raw;
  return Object.entries(parsed as Record<string, unknown>)
    .map(
      ([key, value]) =>
        `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
    )
    .join("\n");
}
