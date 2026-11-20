export interface PairedIndices {
  matched: [number, number][];
  aOnly: number[];
  bOnly: number[];
}

/** Pairs equal keys in A order, consuming B occurrences positionally. */
export function pairIndicesByKey<T, K>(
  entriesA: readonly T[],
  entriesB: readonly T[],
  key: (entry: T) => K,
): PairedIndices {
  const bByKey = new Map<K, number[]>();
  entriesB.forEach((entry, index) => {
    const entryKey = key(entry);
    const bucket = bByKey.get(entryKey);
    if (bucket) {
      bucket.push(index);
    } else {
      bByKey.set(entryKey, [index]);
    }
  });

  const cursor = new Map<K, number>();
  const matched: [number, number][] = [];
  const aOnly: number[] = [];
  const usedB = new Set<number>();
  entriesA.forEach((entry, indexA) => {
    const entryKey = key(entry);
    const position = cursor.get(entryKey) ?? 0;
    const indexB = bByKey.get(entryKey)?.[position];
    if (indexB === undefined) {
      aOnly.push(indexA);
      return;
    }
    cursor.set(entryKey, position + 1);
    matched.push([indexA, indexB]);
    usedB.add(indexB);
  });

  const bOnly = entriesB.flatMap((_, index) =>
    usedB.has(index) ? [] : [index],
  );
  return { matched, aOnly, bOnly };
}
