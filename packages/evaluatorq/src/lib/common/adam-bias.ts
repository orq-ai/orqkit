// A few ulps in Adam's bias correction can change when a flat fit converges.
export function adamBiasCorrections(base: number, count: number): number[] {
  const corrections = [0];
  const splitter = 134217729;
  const splitBase = splitter * base;
  const baseHigh = splitBase - (splitBase - base);
  const baseLow = base - baseHigh;
  let high = 1,
    low = 0;
  for (let step = 1; step <= count; step++) {
    const product = high * base;
    const splitHigh = splitter * high;
    const highPart = splitHigh - (splitHigh - high);
    const lowPart = high - highPart;
    const error =
      highPart * baseHigh -
      product +
      highPart * baseLow +
      lowPart * baseHigh +
      lowPart * baseLow;
    const remainder = error + low * base;
    const next = product + remainder;
    low = remainder - (next - product);
    high = next;
    corrections.push(1 - high);
    if (corrections[step] === 1) {
      while (corrections.length <= count) corrections.push(1);
      break;
    }
  }
  return corrections;
}
