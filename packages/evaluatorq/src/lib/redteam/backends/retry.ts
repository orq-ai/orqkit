import { PIPELINE_CONFIG } from "../config.js";
export function warnIgnoredTargetRetries(
  name: string,
  options: {
    retryCount?: number | null;
    retryOnCodes?: Iterable<number> | null;
  },
): void {
  const countChanged =
    options.retryCount != null &&
    options.retryCount !== PIPELINE_CONFIG.retryCount;
  const codes = options.retryOnCodes == null ? null : [...options.retryOnCodes];
  const codesChanged =
    codes !== null &&
    (codes.length !== PIPELINE_CONFIG.retryOnCodes.length ||
      codes.some((code, i) => code !== PIPELINE_CONFIG.retryOnCodes[i]));
  if (countChanged || codesChanged)
    console.warn(
      `Ignoring retryCount and retryOnCodes for ${name} target calls; callTargetWithRetry owns target retries and the SDK retry budget is disabled at the target-call boundary`,
    );
}
