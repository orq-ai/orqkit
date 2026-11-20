import { pythonStrip } from "../common/sanitize.js";

export interface ParsedIso {
  iso: string;
  epochSeconds: number;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  microsecond: number;
  offsetSeconds: number | null;
}
const DAY = 86400000,
  WEEK = 7 * DAY;
function date(year: number, month: number, day: number): Date {
  const value = new Date(0);
  value.setUTCFullYear(year, month - 1, day);
  value.setUTCHours(0, 0, 0, 0);
  return value;
}
function weekMonday(year: number): number {
  const jan4 = date(year, 1, 4);
  return jan4.getTime() - ((jan4.getUTCDay() || 7) - 1) * DAY;
}
function dateParts(value: string): readonly [number, number, number] | null {
  let match =
    /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) ??
    /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (match && match[0] === value) {
    const y = Number(match[1]),
      m = Number(match[2]),
      d = Number(match[3]),
      parsed = date(y, m, d);
    return y >= 1 &&
      y <= 9999 &&
      parsed.getUTCFullYear() === y &&
      parsed.getUTCMonth() === m - 1 &&
      parsed.getUTCDate() === d
      ? [y, m, d]
      : null;
  }
  match =
    /^(\d{4})-W(\d{2})(?:-(\d))?$/.exec(value) ??
    /^(\d{4})W(\d{2})(\d)?$/.exec(value);
  if (!match || match[0] !== value) return null;
  const year = Number(match[1]),
    week = Number(match[2]),
    day = Number(match[3] ?? 1);
  if (year < 1 || year > 9999 || day < 1 || day > 7) return null;
  const start = weekMonday(year),
    weeks = (weekMonday(year + 1) - start) / WEEK;
  if (week < 1 || week > weeks) return null;
  const parsed = new Date(start + (week - 1) * WEEK + (day - 1) * DAY),
    y = parsed.getUTCFullYear();
  return y < 1 || y > 9999
    ? null
    : [y, parsed.getUTCMonth() + 1, parsed.getUTCDate()];
}
function clockParts(
  value: string,
): readonly [number, number, number, number] | null {
  const pieces = value.split(/[.,]/);
  if (
    pieces.length > 2 ||
    (pieces[1] !== undefined && !/^\d+$/.test(pieces[1]))
  )
    return null;
  const whole = pieces[0] ?? "",
    match = whole.includes(":")
      ? /^(\d{2})(?::(\d{2})(?::(\d{2}))?)?$/.exec(whole)
      : /^(\d{2})(\d{2})?(\d{2})?$/.exec(whole);
  if (!match || match[0] !== whole) return null;
  return [
    Number(match[1]),
    Number(match[2] ?? 0),
    Number(match[3] ?? 0),
    Number((pieces[1] ?? "").slice(0, 6).padEnd(6, "0")),
  ];
}
const pad = (value: number, size = 2) => String(value).padStart(size, "0");
function offsetText(microseconds: bigint): string {
  const sign = microseconds < 0n ? "-" : "+",
    absolute = microseconds < 0n ? -microseconds : microseconds,
    seconds = Number(absolute / 1000000n),
    fraction = Number(absolute % 1000000n),
    hours = Math.floor(seconds / 3600),
    minutes = Math.floor((seconds % 3600) / 60),
    remainder = seconds % 60;
  return `${sign}${pad(hours)}:${pad(minutes)}${remainder || fraction ? `:${pad(remainder)}${fraction ? `.${pad(fraction, 6)}` : ""}` : ""}`;
}
function epochNumber(value: bigint): number {
  const sign = value < 0n ? "-" : "",
    abs = value < 0n ? -value : value;
  return Number(
    `${sign}${abs / 1000000n}.${String(abs % 1000000n).padStart(6, "0")}`,
  );
}
export function parseIso(value: string): ParsedIso {
  const text = pythonStrip(value);
  for (const size of [10, 8, 7]) {
    const parts = dateParts(text.slice(0, size));
    if (!parts) continue;
    const [year, month, day] = parts;
    let hour = 0,
      minute = 0,
      second = 0,
      microsecond = 0,
      offsetMicro: bigint | null = null;
    if (text.length > size) {
      const tail = Array.from(text.slice(size)).slice(1).join("");
      if (!tail) continue;
      const split = tail.search(/[Zz+-]/),
        time = split < 0 ? tail : tail.slice(0, split),
        offset = split < 0 ? null : tail.slice(split),
        initialClock = clockParts(time);
      let clock = initialClock;
      if (
        !clock &&
        offset !== null &&
        !/[.,]/.test(time.slice(0, -1)) &&
        time.charCodeAt(time.length - 1) < 128
      )
        clock = clockParts(time.slice(0, -1));
      if (!clock) continue;
      [hour, minute, second, microsecond] = clock;
      if (hour > 23 || minute > 59 || second > 59) continue;
      if (offset !== null) {
        if (offset === "Z" || offset === "z") offsetMicro = 0n;
        else {
          if (!/^[+-]/.test(offset)) continue;
          const zone = clockParts(offset.slice(1));
          if (!zone) continue;
          const [h, m, s, micro] = zone,
            total = h * 3600 + m * 60 + s;
          if (total >= 86400) continue;
          offsetMicro =
            BigInt(total ? total * 1000000 + micro : 0) *
            (offset.startsWith("-") ? -1n : 1n);
          if (offsetMicro <= -86400000000n || offsetMicro >= 86400000000n)
            continue;
        }
      }
    }
    const unixSecond = BigInt(
        date(year, month, day).getTime() / 1000 +
          hour * 3600 +
          minute * 60 +
          second,
      ),
      epochMicro =
        unixSecond * 1000000n + BigInt(microsecond) - (offsetMicro ?? 0n);
    const iso = `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}${microsecond ? `.${pad(microsecond, 6)}` : ""}${offsetMicro === null ? "" : offsetText(offsetMicro)}`;
    return {
      iso,
      epochSeconds: epochNumber(epochMicro),
      year,
      month,
      day,
      hour,
      minute,
      second,
      microsecond,
      offsetSeconds:
        offsetMicro === null ? null : Number(offsetMicro) / 1000000,
    };
  }
  throw new RangeError("Invalid ISO 8601 datetime");
}
