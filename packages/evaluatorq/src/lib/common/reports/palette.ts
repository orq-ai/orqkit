export const COLORS = {
  orange_300: "#ff8f34",
  orange_400: "#df5325",
  teal_400: "#025558",
  teal_500: "#01483d",
  ink_700: "#25232e",
  ink_800: "#1a1921",
  sand_100: "#f9f8f6",
  sand_400: "#e4e2df",
  turquoise_400: "#00ffdd",
  blue_400: "#4fd2ff",
  success_400: "#2ebd85",
  yellow_400: "#f2b600",
  red_400: "#d92d20",
  info_400: "#2f80ed",
  purple_400: "#7e22ce",
} as const;

export const SEVERITY_COLORS = {
  critical: COLORS.red_400,
  high: COLORS.orange_300,
  medium: COLORS.yellow_400,
  low: COLORS.success_400,
} as const;

export const SEVERITY_ORDER = ["critical", "high", "medium", "low"] as const;

export const SEVERITY_WEIGHTS = {
  critical: 8,
  high: 4,
  medium: 2,
  low: 1,
} as const;

export const SEVERITY_RANK = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
} as const;

export const STATUS_COLORS = {
  vulnerable: COLORS.red_400,
  resistant: COLORS.success_400,
  error: COLORS.yellow_400,
} as const;

export type ColorScale = readonly (readonly [number, string])[];

export const ORQ_SCALE_HEAT: ColorScale = [
  [0.0, COLORS.sand_100],
  [0.5, COLORS.orange_300],
  [1.0, COLORS.red_400],
];

export const ORQ_SCALE_GOOD_BAD: ColorScale = [
  [0.0, COLORS.success_400],
  [0.5, COLORS.yellow_400],
  [1.0, COLORS.red_400],
];

export const ORQ_SCALE_AGENT: ColorScale = [
  [0.0, COLORS.sand_100],
  [0.5, COLORS.orange_300],
  [1.0, COLORS.teal_400],
];

export const QUALITATIVE = [
  COLORS.success_400,
  COLORS.orange_300,
  COLORS.purple_400,
  COLORS.turquoise_400,
  COLORS.teal_400,
  COLORS.blue_400,
  COLORS.orange_400,
  COLORS.info_400,
] as const;
