export const LINE_BREAKS =
  "\\r\\n|[\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85\\u2028\\u2029]";
const LINE_END = new RegExp(LINE_BREAKS, "g");
const CONTEXT = 3;

/** `str.splitlines(keepends=True)`, which breaks on more than `\n`. */
export function splitLinesKeepEnds(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (const match of text.matchAll(LINE_END)) {
    const end = match.index + match[0].length;
    lines.push(text.slice(start, end));
    start = end;
  }
  if (start < text.length) {
    lines.push(text.slice(start));
  }
  return lines;
}

type Opcode = [tag: string, i1: number, i2: number, j1: number, j2: number];

interface Match {
  a: number;
  b: number;
  size: number;
}

// difflib's matcher rather than Myers, so a reviewer sees the same hunks as Python.
function indexB(b: readonly string[]): Map<string, number[]> {
  const positions = new Map<string, number[]>();
  b.forEach((line, index) => {
    const known = positions.get(line);
    if (known) {
      known.push(index);
    } else {
      positions.set(line, [index]);
    }
  });
  if (b.length >= 200) {
    const limit = Math.floor(b.length / 100) + 1;
    for (const [line, indices] of positions) {
      if (indices.length > limit) {
        positions.delete(line);
      }
    }
  }
  return positions;
}

function longestMatch(
  a: readonly string[],
  b: readonly string[],
  positions: Map<string, number[]>,
  alo: number,
  ahi: number,
  blo: number,
  bhi: number,
): Match {
  let bestA = alo;
  let bestB = blo;
  let bestSize = 0;
  let lengths = new Map<number, number>();
  for (let i = alo; i < ahi; i += 1) {
    const next = new Map<number, number>();
    for (const j of positions.get(a[i] as string) ?? []) {
      if (j < blo) {
        continue;
      }
      if (j >= bhi) {
        break;
      }
      const size = (lengths.get(j - 1) ?? 0) + 1;
      next.set(j, size);
      if (size > bestSize) {
        bestA = i - size + 1;
        bestB = j - size + 1;
        bestSize = size;
      }
    }
    lengths = next;
  }
  // Popular lines are absent from `positions`, so extend across them here.
  while (bestA > alo && bestB > blo && a[bestA - 1] === b[bestB - 1]) {
    bestA -= 1;
    bestB -= 1;
    bestSize += 1;
  }
  while (
    bestA + bestSize < ahi &&
    bestB + bestSize < bhi &&
    a[bestA + bestSize] === b[bestB + bestSize]
  ) {
    bestSize += 1;
  }
  return { a: bestA, b: bestB, size: bestSize };
}

function matchingBlocks(a: readonly string[], b: readonly string[]): Match[] {
  const positions = indexB(b);
  const queue: Array<[number, number, number, number]> = [
    [0, a.length, 0, b.length],
  ];
  const found: Match[] = [];
  while (queue.length > 0) {
    const [alo, ahi, blo, bhi] = queue.pop() as [
      number,
      number,
      number,
      number,
    ];
    const match = longestMatch(a, b, positions, alo, ahi, blo, bhi);
    if (match.size > 0) {
      found.push(match);
      if (alo < match.a && blo < match.b) {
        queue.push([alo, match.a, blo, match.b]);
      }
      if (match.a + match.size < ahi && match.b + match.size < bhi) {
        queue.push([match.a + match.size, ahi, match.b + match.size, bhi]);
      }
    }
  }
  found.sort((x, y) => x.a - y.a || x.b - y.b);
  const merged: Match[] = [];
  for (const block of found) {
    const last = merged.at(-1);
    if (
      last &&
      last.a + last.size === block.a &&
      last.b + last.size === block.b
    ) {
      last.size += block.size;
    } else {
      merged.push({ ...block });
    }
  }
  merged.push({ a: a.length, b: b.length, size: 0 });
  return merged;
}

function opcodes(a: readonly string[], b: readonly string[]): Opcode[] {
  const codes: Opcode[] = [];
  let i = 0;
  let j = 0;
  for (const block of matchingBlocks(a, b)) {
    const tag =
      i < block.a && j < block.b
        ? "replace"
        : i < block.a
          ? "delete"
          : j < block.b
            ? "insert"
            : "";
    if (tag) {
      codes.push([tag, i, block.a, j, block.b]);
    }
    i = block.a + block.size;
    j = block.b + block.size;
    if (block.size > 0) {
      codes.push(["equal", block.a, i, block.b, j]);
    }
  }
  return codes;
}

function groupedOpcodes(
  a: readonly string[],
  b: readonly string[],
): Opcode[][] {
  const codes = opcodes(a, b);
  if (codes.length === 0) {
    codes.push(["equal", 0, 1, 0, 1]);
  }
  const first = codes[0] as Opcode;
  if (first[0] === "equal") {
    codes[0] = [
      "equal",
      Math.max(first[1], first[2] - CONTEXT),
      first[2],
      Math.max(first[3], first[4] - CONTEXT),
      first[4],
    ];
  }
  const last = codes.at(-1) as Opcode;
  if (last[0] === "equal") {
    codes[codes.length - 1] = [
      "equal",
      last[1],
      Math.min(last[2], last[1] + CONTEXT),
      last[3],
      Math.min(last[4], last[3] + CONTEXT),
    ];
  }
  const groups: Opcode[][] = [];
  let group: Opcode[] = [];
  for (const code of codes) {
    let [tag, i1, i2, j1, j2] = code;
    if (tag === "equal" && i2 - i1 > CONTEXT * 2) {
      group.push([
        tag,
        i1,
        Math.min(i2, i1 + CONTEXT),
        j1,
        Math.min(j2, j1 + CONTEXT),
      ]);
      groups.push(group);
      group = [];
      i1 = Math.max(i1, i2 - CONTEXT);
      j1 = Math.max(j1, j2 - CONTEXT);
    }
    group.push([tag, i1, i2, j1, j2]);
  }
  if (group.length > 0 && !(group.length === 1 && group[0]?.[0] === "equal")) {
    groups.push(group);
  }
  return groups;
}

function formatRange(start: number, stop: number): string {
  const length = stop - start;
  if (length === 1) {
    return String(start + 1);
  }
  return `${length === 0 ? start : start + 1},${length}`;
}

/** `difflib.unified_diff` over the lines of two strings, joined. */
export function unifiedDiff(
  original: string,
  revised: string,
  options: { fromFile: string; toFile: string },
): string {
  const a = splitLinesKeepEnds(original);
  const b = splitLinesKeepEnds(revised);
  let out = "";
  for (const group of groupedOpcodes(a, b)) {
    if (out === "") {
      out += `--- ${options.fromFile}\n+++ ${options.toFile}\n`;
    }
    const first = group[0] as Opcode;
    const last = group.at(-1) as Opcode;
    out += `@@ -${formatRange(first[1], last[2])} +${formatRange(first[3], last[4])} @@\n`;
    for (const [tag, i1, i2, j1, j2] of group) {
      if (tag === "equal") {
        out += a
          .slice(i1, i2)
          .map((line) => ` ${line}`)
          .join("");
        continue;
      }
      if (tag === "replace" || tag === "delete") {
        out += a
          .slice(i1, i2)
          .map((line) => `-${line}`)
          .join("");
      }
      if (tag === "replace" || tag === "insert") {
        out += b
          .slice(j1, j2)
          .map((line) => `+${line}`)
          .join("");
      }
    }
  }
  return out;
}
