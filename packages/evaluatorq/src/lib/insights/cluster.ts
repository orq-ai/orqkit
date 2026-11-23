export const MAX_LINKAGE_OBSERVATIONS = 5000;
export interface ClusterTree {
  baseLabels: number[];
  topOfBase: Record<number, number>;
  nBase: number;
  nTop: number;
}
export function centroids(
  vectors: readonly (readonly number[])[],
  labels: readonly number[],
): Record<number, number[]> {
  if (vectors.length !== labels.length)
    throw new Error("labels must align with vectors");
  const ids = [...new Set(labels)]
    .filter((label) => label !== -1)
    .sort((a, b) => a - b);
  return Object.fromEntries(
    ids.map((id) => {
      const members = vectors.filter((_, i) => labels[i] === id),
        width = members[0]?.length ?? 0;
      const mean = Array.from(
        { length: width },
        (_, j) =>
          members.reduce((sum, row) => sum + (row[j] as number), 0) /
          members.length,
      );
      return [id, mean];
    }),
  );
}
export function cosineSimilarity(
  a: readonly number[],
  b: readonly number[],
): number {
  if (a.length !== b.length)
    throw new Error("vectors must have equal dimensions");
  const dot = a.reduce((sum, value, i) => sum + value * (b[i] as number), 0),
    denom =
      Math.sqrt(a.reduce((sum, v) => sum + v * v, 0)) *
      Math.sqrt(b.reduce((sum, v) => sum + v * v, 0));
  return denom === 0 ? 0 : dot / denom;
}
export function nearestNeighbours(
  cents: Readonly<Record<number, readonly number[]>>,
  k = 3,
): Record<number, number[]> {
  if (k < 0) throw new RangeError("k must be non-negative");
  const ids = Object.keys(cents)
    .map(Number)
    .sort((a, b) => a - b);
  return Object.fromEntries(
    ids.map((id) => [
      id,
      ids
        .filter((other) => other !== id)
        .map((other) => ({
          id: other,
          similarity: cosineSimilarity(
            cents[id] as readonly number[],
            cents[other] as readonly number[],
          ),
        }))
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, k)
        .map((item) => item.id),
    ]),
  );
}
export function gapOptimalK(
  linkage: readonly (readonly number[])[],
  n: number,
  options: { kMin?: number; kMax: number },
): number {
  const min = options.kMin ?? 2,
    max = n > 1 ? Math.max(min, Math.min(options.kMax, n - 1)) : min,
    distances = linkage.map((row) => row[2] as number).sort((a, b) => a - b);
  if (distances.length < 2 || Math.max(...distances) < 1e-10) return min;
  let best = min,
    bestGap = -1;
  for (let i = 0; i < distances.length - 1; i++) {
    const current = distances[i] as number;
    if (current <= 0) continue;
    const gap = ((distances[i + 1] as number) - current) / current,
      k = n - i - 1;
    if (k >= min && k <= max && gap > bestGap) {
      bestGap = gap;
      best = k;
    }
  }
  return best;
}
export function flagOutliers(
  vectors: readonly (readonly number[])[],
  baseLabels: readonly number[],
  zscore: number,
): number[] {
  const labels = [...baseLabels];
  for (const label of [...new Set(baseLabels)].sort((a, b) => a - b)) {
    if (label === -1) continue;
    const indices = baseLabels.flatMap((value, i) =>
      value === label ? [i] : [],
    );
    if (indices.length < 3) continue;
    const members = indices.map((i) => vectors[i] as readonly number[]),
      mean = Array.from(
        { length: members[0]?.length ?? 0 },
        (_, j) =>
          members.reduce((sum, row) => sum + (row[j] as number), 0) /
          members.length,
      ),
      norm = Math.sqrt(mean.reduce((sum, value) => sum + value * value, 0)),
      center = norm > 0 ? mean.map((value) => value / norm) : mean,
      distances = members.map(
        (row) =>
          1 -
          row.reduce((sum, value, j) => sum + value * (center[j] as number), 0),
      ),
      average = distances.reduce((a, b) => a + b, 0) / distances.length,
      variance =
        distances.reduce((sum, value) => sum + (value - average) ** 2, 0) /
        (distances.length - 1),
      threshold = average + zscore * Math.sqrt(variance);
    for (const [i, distance] of distances.entries())
      if (distance > threshold) labels[indices[i] as number] = -1;
  }
  return labels;
}
export function activeTreeMetadata(
  labels: readonly number[],
  topOfBase: Readonly<Record<number, number>>,
): readonly [number[], Record<number, number>, number, number] {
  const ids = [...new Set(labels)]
      .filter((id) => id !== -1)
      .sort((a, b) => a - b),
    tops = [
      ...new Set(
        ids.map((id) => {
          if (!Object.hasOwn(topOfBase, id))
            throw new Error(`Missing top cluster for ${id}`);
          return topOfBase[id] as number;
        }),
      ),
    ].sort((a, b) => a - b),
    remap = new Map(ids.map((id, index) => [id, index])),
    topRemap = new Map(tops.map((id, index) => [id, index]));
  return [
    labels.map((id) => (id === -1 ? -1 : (remap.get(id) as number))),
    Object.fromEntries(
      ids.map((id) => [remap.get(id), topRemap.get(topOfBase[id] as number)]),
    ),
    ids.length,
    tops.length,
  ];
}

export type LinkageRow = readonly [number, number, number, number];
export function wardLinkage(
  vectors: readonly (readonly number[])[],
): LinkageRow[] {
  const n = vectors.length;
  if (n < 2) throw new Error("at least two vectors are required");
  const width = vectors[0]?.length ?? 0;
  if (
    vectors.some(
      (row) =>
        row.length !== width || row.some((value) => !Number.isFinite(value)),
    )
  )
    throw new Error("vectors must form a finite matrix");
  const distances = new Float64Array((n * (n - 1)) / 2),
    sizes = new Int32Array(n).fill(1),
    slot = (a: number, b: number) => {
      const x = Math.min(a, b),
        y = Math.max(a, b);
      return n * x - (x * (x + 1)) / 2 + y - x - 1;
    };
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      let square = 0;
      for (let k = 0; k < width; k++) {
        const diff = (vectors[i]?.[k] as number) - (vectors[j]?.[k] as number);
        square += diff * diff;
      }
      distances[slot(i, j)] = Math.sqrt(square);
    }
  const chain: number[] = [],
    merges: { left: number; right: number; distance: number; order: number }[] =
      [];
  for (let order = 0; order < n - 1; order++) {
    if (!chain.length) chain.push(sizes.findIndex((size) => size > 0));
    let x = 0,
      y = 0,
      min = 0;
    for (;;) {
      x = chain[chain.length - 1] as number;
      y = chain.length > 1 ? (chain[chain.length - 2] as number) : -1;
      min = y < 0 ? Infinity : (distances[slot(x, y)] as number);
      for (let candidate = 0; candidate < n; candidate++)
        if (candidate !== x && (sizes[candidate] as number) > 0) {
          const distance = distances[slot(x, candidate)] as number;
          if (distance < min) {
            min = distance;
            y = candidate;
          }
        }
      if (chain.length > 1 && y === chain[chain.length - 2]) break;
      chain.push(y);
    }
    chain.splice(-2);
    if (x > y) [x, y] = [y, x];
    const nx = sizes[x] as number,
      ny = sizes[y] as number;
    merges.push({ left: x, right: y, distance: min, order });
    sizes[x] = 0;
    sizes[y] = nx + ny;
    for (let i = 0; i < n; i++) {
      const ni = sizes[i] as number;
      if (!ni || i === y) continue;
      const dx = distances[slot(i, x)] as number,
        dy = distances[slot(i, y)] as number,
        t = 1 / (nx + ny + ni);
      distances[slot(i, y)] = Math.sqrt(
        (ni + nx) * t * dx * dx + (ni + ny) * t * dy * dy - ni * t * min * min,
      );
    }
  }
  merges.sort((a, b) => a.distance - b.distance || a.order - b.order);
  const parents = Array.from({ length: 2 * n - 1 }, (_, i) => i),
    counts = new Int32Array(2 * n - 1).fill(1),
    find = (id: number): number => {
      let root = id;
      while (parents[root] !== root) root = parents[root] as number;
      while (parents[id] !== root) {
        const next = parents[id] as number;
        parents[id] = root;
        id = next;
      }
      return root;
    };
  return merges.map((merge, index) => {
    const a = find(merge.left),
      b = find(merge.right),
      left = Math.min(a, b),
      right = Math.max(a, b),
      next = n + index,
      size = (counts[a] as number) + (counts[b] as number);
    parents[a] = next;
    parents[b] = next;
    counts[next] = size;
    return [left, right, merge.distance, size] as const;
  });
}
export function flatClusters(
  linkage: readonly LinkageRow[],
  maxClusters: number,
): number[] {
  const n = linkage.length + 1;
  if (maxClusters >= n) return Array.from({ length: n }, (_, i) => i + 1);
  const maxDistances: number[] = [];
  for (const [left, right, distance] of linkage)
    maxDistances.push(
      Math.max(
        distance,
        left >= n ? (maxDistances[left - n] as number) : -Infinity,
        right >= n ? (maxDistances[right - n] as number) : -Infinity,
      ),
    );
  const cutoff = maxDistances[Math.max(0, n - maxClusters - 1)] as number,
    labels = new Array<number>(n),
    stack: { node: number; exit: boolean }[] = [
      { node: 2 * n - 2, exit: false },
    ];
  let leader = -1,
    count = 0;
  while (stack.length) {
    const frame = stack.pop() as { node: number; exit: boolean },
      row = linkage[frame.node - n] as LinkageRow,
      [left, right] = row;
    if (!frame.exit) {
      if (leader < 0 && (maxDistances[frame.node - n] as number) <= cutoff) {
        leader = frame.node;
        count++;
      }
      stack.push({ node: frame.node, exit: true });
      if (right >= n) stack.push({ node: right, exit: false });
      if (left >= n) stack.push({ node: left, exit: false });
      continue;
    }
    for (const child of [left, right])
      if (child < n) {
        if (leader < 0) count++;
        labels[child] = count;
      }
    if (leader === frame.node) leader = -1;
  }
  return labels;
}

export const WEAK_SILHOUETTE = 0.2;
export function silhouette(
  vectors: readonly (readonly number[])[],
  labels: readonly number[],
): number {
  const groups = new Map<number, number[]>();
  labels.forEach((label, index) => {
    const group = groups.get(label) ?? [];
    group.push(index);
    groups.set(label, group);
  });
  if (groups.size <= 1) return 0;
  const scores = labels.map((label, index) => {
    const own = groups.get(label) as number[];
    if (own.length <= 1) return 0;
    const distance = (other: number) => {
      if (other === index) return 0;
      const a = vectors[index] as readonly number[],
        b = vectors[other] as readonly number[],
        similarity = cosineSimilarity(a, b);
      return Math.max(0, Math.min(2, 1 - similarity));
    };
    const within =
      own.reduce((sum, other) => sum + distance(other), 0) / (own.length - 1);
    let nearest = Infinity;
    for (const [other, members] of groups)
      if (other !== label)
        nearest = Math.min(
          nearest,
          members.reduce((sum, member) => sum + distance(member), 0) /
            members.length,
        );
    const scale = Math.max(within, nearest);
    return scale === 0 ? 0 : (nearest - within) / scale;
  });
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}
function buildTree(
  vectors: readonly (readonly number[])[],
  labels: readonly number[],
  top: Readonly<Record<number, number>>,
  outlier: number | null,
): ClusterTree {
  const final =
      outlier === null ? [...labels] : flagOutliers(vectors, labels, outlier),
    [baseLabels, topOfBase, nBase, nTop] = activeTreeMetadata(final, top);
  return { baseLabels, topOfBase, nBase, nTop };
}
export function clusterTwoLevel(
  vectors: readonly (readonly number[])[],
  options: {
    maxClusters?: number;
    maxSubclusters?: number;
    minClusterSize?: number;
    outlierZscore?: number | null;
  } = {},
): ClusterTree {
  const maxClusters = options.maxClusters ?? 15,
    maxSubclusters = options.maxSubclusters ?? 15,
    minClusterSize = options.minClusterSize ?? 5,
    outlier = options.outlierZscore ?? null;
  for (const [name, value] of [
    ["max_clusters", maxClusters],
    ["max_subclusters", maxSubclusters],
    ["min_cluster_size", minClusterSize],
  ] as const)
    if (value < 1) throw new Error(`${name} must be positive`);
  if (outlier !== null && (!Number.isFinite(outlier) || outlier < 0))
    throw new Error("outlier_zscore must be non-negative and finite");
  const isMatrix = (input: unknown): boolean =>
    Array.isArray(input) && input.every((row) => Array.isArray(row));
  if (!isMatrix(vectors))
    throw new Error("vectors must be a two-dimensional matrix");
  const width = vectors[0]?.length ?? 0;
  if (
    vectors.some(
      (row) =>
        row.length !== width || row.some((value) => !Number.isFinite(value)),
    )
  )
    throw new Error("vectors must contain only finite values");
  const n = vectors.length;
  if (!n) return { baseLabels: [], topOfBase: {}, nBase: 0, nTop: 0 };
  const normed = vectors.map((row) => {
    const norm =
      Math.sqrt(row.reduce((sum, value) => sum + value * value, 0)) || 1;
    return row.map((value) => value / norm);
  });
  if (n < 2 * minClusterSize)
    return buildTree(normed, new Array(n).fill(0), { 0: 0 }, outlier);
  if (n > MAX_LINKAGE_OBSERVATIONS)
    throw new Error(
      `clustering supports at most ${MAX_LINKAGE_OBSERVATIONS} traces per population; reduce the requested trace window or use a scalable clustering backend`,
    );
  const zBase = wardLinkage(normed),
    maxBase = Math.min(
      maxClusters * maxSubclusters,
      Math.floor(n / minClusterSize),
    );
  let kBase = gapOptimalK(zBase, n, { kMin: 2, kMax: maxBase }),
    floor = Math.min(maxBase, Math.floor(n / (2 * minClusterSize)));
  if (
    floor > kBase &&
    silhouette(normed, flatClusters(zBase, kBase)) < WEAK_SILHOUETTE
  )
    kBase = floor;
  let base = flatClusters(zBase, kBase).map((value) => value - 1),
    baseCenters = centroids(normed, base),
    baseIds = Object.keys(baseCenters)
      .map(Number)
      .sort((a, b) => a - b),
    nBase = baseIds.length;
  if (nBase < 2)
    return buildTree(
      normed,
      activeTreeMetadata(
        base,
        Object.fromEntries(baseIds.map((id) => [id, 0])),
      )[0],
      Object.fromEntries(baseIds.map((_, index) => [index, 0])),
      outlier,
    );
  const zTop = wardLinkage(baseIds.map((id) => baseCenters[id] as number[]));
  let kTop = gapOptimalK(zTop, nBase, { kMin: 1, kMax: maxClusters }),
    topLabels = flatClusters(zTop, kTop),
    top = new Map(
      baseIds.map((id, index) => [id, (topLabels[index] as number) - 1]),
    );
  const maxGroup = () => {
    const counts = new Map<number, number>();
    for (const group of top.values())
      counts.set(group, (counts.get(group) ?? 0) + 1);
    return counts.size ? Math.max(...counts.values()) : 0;
  };
  while (maxGroup() > maxSubclusters && kTop < maxClusters) {
    kTop++;
    topLabels = flatClusters(zTop, kTop);
    top = new Map(
      baseIds.map((id, index) => [id, (topLabels[index] as number) - 1]),
    );
  }
  while (maxGroup() > maxSubclusters) {
    const counts = new Map<number, number>();
    for (const group of top.values())
      counts.set(group, (counts.get(group) ?? 0) + 1);
    let targetGroup: number | null = null,
      largest = -1;
    for (const [group, count] of counts)
      if (count > largest) {
        largest = count;
        targetGroup = group;
      }
    if (targetGroup === null) break;
    while (true) {
      const members = [...top]
        .filter(([, group]) => group === targetGroup)
        .map(([id]) => id);
      if (members.length <= maxSubclusters) break;
      const centers = centroids(normed, base),
        sizes = new Map(
          members.map((id) => [
            id,
            base.filter((label) => label === id).length,
          ]),
        );
      let victim = members[0] as number;
      for (const id of members)
        if ((sizes.get(id) as number) < (sizes.get(victim) as number))
          victim = id;
      const siblings = members.filter((id) => id !== victim);
      let target = siblings[0] as number,
        best = -Infinity;
      for (const id of siblings) {
        const similarity = cosineSimilarity(
          centers[victim] as number[],
          centers[id] as number[],
        );
        if (similarity > best) {
          best = similarity;
          target = id;
        }
      }
      base = base.map((id) => (id === victim ? target : id));
      top.delete(victim);
    }
  }
  const oldIds = [...top.keys()].sort((a, b) => a - b),
    oldToNew = new Map(oldIds.map((id, index) => [id, index]));
  base = base.map((id) => oldToNew.get(id) as number);
  top = new Map(
    oldIds.map((id) => [oldToNew.get(id) as number, top.get(id) as number]),
  );
  const children = new Map<number, number[]>();
  for (const [id, group] of top) {
    const list = children.get(group) ?? [];
    list.push(id);
    children.set(group, list);
  }
  for (const [group, ids] of children) {
    if (ids.length !== 1) continue;
    const rows = base.flatMap((id, index) => (id === ids[0] ? [index] : []));
    if (rows.length < 2 * minClusterSize) continue;
    const halves = flatClusters(
        wardLinkage(rows.map((index) => normed[index] as number[])),
        2,
      ),
      one = halves.filter((id) => id === 1).length,
      two = halves.filter((id) => id === 2).length;
    if (Math.min(one, two) < minClusterSize) continue;
    const next = Math.max(...top.keys()) + 1;
    rows.forEach((row, index) => {
      if (halves[index] === 2) base[row] = next;
    });
    top.set(next, group);
  }
  const topIds = [...new Set(top.values())].sort((a, b) => a - b),
    remap = new Map(topIds.map((id, index) => [id, index]));
  return buildTree(
    normed,
    base,
    Object.fromEntries(
      [...top].map(([id, group]) => [id, remap.get(group) as number]),
    ),
    outlier,
  );
}
