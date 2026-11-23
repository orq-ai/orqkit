export type Role = "fast" | "smart" | "classifier" | "embedding";
export const ROLES: readonly Role[] = [
  "fast",
  "smart",
  "classifier",
  "embedding",
];

export const TASKS: Readonly<Record<string, Role>> = {
  "redteam.attacker": "smart",
  "redteam.evaluator": "smart",
  "redteam.refusal_judge": "classifier",
  "sim.user": "fast",
  "sim.judge": "smart",
  "sim.generator": "fast",
  "finder.compiler": "fast",
  "finder.filters": "fast",
  "finder.classifier": "classifier",
  "insights.summary": "smart",
  "insights.labels": "classifier",
  "insights.embedding": "embedding",
  signals: "classifier",
  apply: "smart",
};
