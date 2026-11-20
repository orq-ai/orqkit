export const DEFAULT_DATAPOINT_PARALLELISM = 10;

/** The new name wins when both are supplied, so a caller mid-migration is not held to the old value. */
export function resolveDatapointParallelism(
  datapointParallelism: number | null | undefined,
  parallelism: number | null | undefined,
  options: { default?: number; caller: string },
): number {
  const { caller, default: fallback = DEFAULT_DATAPOINT_PARALLELISM } = options;
  if (parallelism === null || parallelism === undefined) {
    return datapointParallelism ?? fallback;
  }
  console.warn(
    `${caller}(parallelism) is deprecated; use datapointParallelism for the datapoint count, or llmParallelism to bound concurrent LLM requests.`,
  );
  if (datapointParallelism !== null && datapointParallelism !== undefined) {
    console.warn(
      `${caller}() got both parallelism and datapointParallelism; using datapointParallelism.`,
    );
    return datapointParallelism;
  }
  return parallelism;
}
