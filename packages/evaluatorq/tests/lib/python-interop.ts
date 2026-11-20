export function keyPaths(value: unknown, prefix = ""): Set<string> {
  const out = new Set<string>();
  if (Array.isArray(value))
    for (const item of value)
      for (const path of keyPaths(item, `${prefix}[]`)) out.add(path);
  else if (value !== null && typeof value === "object")
    for (const [key, child] of Object.entries(value)) {
      out.add(`${prefix}/${key}`);
      for (const path of keyPaths(child, `${prefix}/${key}`)) out.add(path);
    }
  return out;
}

const COMPUTED = /\/(prompt_tokens|completion_tokens|cost_usd)$/;

export function keyDiff(python: unknown, ts: unknown) {
  const a = keyPaths(python),
    b = keyPaths(ts);
  return {
    onlyPython: [...a].filter((k) => !b.has(k) && !COMPUTED.test(k)).sort(),
    onlyTs: [...b].filter((k) => !a.has(k)).sort(),
  };
}
