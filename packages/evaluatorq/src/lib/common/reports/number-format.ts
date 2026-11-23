const TIE_TAIL = /^50*$/;

function isLastDigitEven(digits: string): boolean {
  return Number(digits.at(-1) ?? "0") % 2 === 0;
}

/** Python's `f"{value:.{places}f}"`: `toFixed` rounds exact ties up, Python to even. */
export function pyFixed(value: number, places: number): string {
  if (Number.isNaN(value)) {
    return "nan";
  }
  if (!Number.isFinite(value)) {
    return value > 0 ? "inf" : "-inf";
  }
  if (Object.is(value, -0)) {
    return `-${(0).toFixed(places)}`;
  }
  if (Math.abs(value) >= 1e21) {
    return `${BigInt(value)}${places > 0 ? `.${"0".repeat(places)}` : ""}`;
  }
  const rounded = value.toFixed(places);
  const expanded = Math.abs(value).toFixed(100);
  const [whole = "0", fraction = ""] = expanded.split(".");
  const kept = fraction.slice(0, places);
  if (
    !TIE_TAIL.test(fraction.slice(places)) ||
    !isLastDigitEven(whole + kept)
  ) {
    return rounded;
  }
  const sign = value < 0 ? "-" : "";
  return places === 0 ? `${sign}${whole}` : `${sign}${whole}.${kept}`;
}

/** Python's `f"{rate:.0%}"`, which multiplies in floating point before formatting. */
export function pyPercent(rate: number): string {
  return `${pyFixed(rate * 100, 0)}%`;
}

export function groupThousands(text: string): string {
  const [whole = "", fraction] = text.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+$)/g, ",");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

/** Python's `round()` on a float: exact halves go to the even neighbour. */
export function pyRound(value: number): number {
  const floor = Math.floor(value);
  const delta = value - floor;
  if (delta !== 0.5) {
    return Math.round(value);
  }
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Six significant digits, half-even on exact ties, as the digits and base-10 exponent. */
function sixSignificant(abs: number): { digits: string; exponent: number } {
  const [mantissa = "0", exponentText = "0"] = abs.toExponential(5).split("e");
  const rounded = {
    digits: mantissa.replace(".", ""),
    exponent: Number(exponentText),
  };
  const expanded = abs.toFixed(100);
  if (expanded.includes("e")) {
    return rounded;
  }
  const all = expanded.replace(".", "");
  const first = all.search(/[1-9]/);
  if (first < 0) {
    return rounded;
  }
  const kept = all.slice(first, first + 6);
  if (kept.length < 6 || !TIE_TAIL.test(all.slice(first + 6))) {
    return rounded;
  }
  return isLastDigitEven(kept) ? { ...rounded, digits: kept } : rounded;
}

/** Python's `f"{value:g}"`. */
export function pyG(value: number): string {
  if (Number.isNaN(value)) {
    return "nan";
  }
  if (!Number.isFinite(value)) {
    return value > 0 ? "inf" : "-inf";
  }
  const sign = value < 0 || Object.is(value, -0) ? "-" : "";
  if (value === 0) {
    return `${sign}0`;
  }
  const { digits, exponent } = sixSignificant(Math.abs(value));
  const trimmed = digits.replace(/0+$/, "");
  if (exponent < -4 || exponent >= 6) {
    const tail = trimmed.length > 1 ? `.${trimmed.slice(1)}` : "";
    const magnitude = String(Math.abs(exponent)).padStart(2, "0");
    return `${sign}${trimmed[0]}${tail}e${exponent < 0 ? "-" : "+"}${magnitude}`;
  }
  if (exponent < 0) {
    return `${sign}0.${"0".repeat(-exponent - 1)}${trimmed}`;
  }
  const whole = trimmed.slice(0, exponent + 1).padEnd(exponent + 1, "0");
  const fraction = trimmed.slice(exponent + 1);
  return `${sign}${whole}${fraction ? `.${fraction}` : ""}`;
}

export function pyFloat(value: number): string {
  if (!Number.isFinite(value))
    return Number.isNaN(value) ? "nan" : value > 0 ? "inf" : "-inf";
  if (Object.is(value, -0)) return "-0.0";
  const abs = Math.abs(value);
  if (abs >= 1e16 || (abs > 0 && abs < 0.0001)) {
    const [mantissa, exponent] = value.toExponential().split("e"),
      e = Number(exponent);
    return `${mantissa}e${e < 0 ? "-" : "+"}${String(Math.abs(e)).padStart(2, "0")}`;
  }
  return String(value) + (Number.isInteger(value) ? ".0" : "");
}
