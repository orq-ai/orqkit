import { pythonString } from "../common/sanitize.js";
import {
  type DimensionResult,
  type LabelSpec,
  type PriorityPoint,
  PriorityPointSchema,
  realAssistantErrors,
  type TraceInsight,
} from "./models.js";

const repr = (value: string) => pythonString([value]).slice(1, -1);
export function priorityPoints(
  traces: readonly TraceInsight[],
  dimension: DimensionResult,
  options: {
    satisfactionSpec: LabelSpec;
    satisfactionLabel?: string;
    errorsLabel?: string;
  },
): [PriorityPoint[] | null, string | null] {
  const satisfaction = options.satisfactionLabel ?? "customer_satisfaction",
    errors = options.errorsLabel ?? "made_errors";
  if (options.satisfactionSpec.kind !== "score")
    return [
      null,
      `the ${repr(satisfaction)} label must be a score label for the priority matrix`,
    ];
  if (!traces.some((trace) => Object.hasOwn(trace.labels, satisfaction)))
    return [
      null,
      `the ${repr(satisfaction)} label was not requested for this run`,
    ];
  const errorsRequested = traces.some((trace) =>
    Object.hasOwn(trace.labels, errors),
  );
  const degraded = errorsRequested
    ? null
    : `error share taken from summary assistant_errors; the ${repr(errors)} label was not requested`;
  const byId = new Map(traces.map((trace) => [trace.traceId, trace])),
    points: PriorityPoint[] = [];
  let withSatisfaction = 0,
    withoutSummaries = 0;
  for (const cluster of dimension.clusters) {
    if (cluster.level !== "base") continue;
    const members = cluster.traceIds.flatMap((id) =>
      byId.has(id) ? [byId.get(id) as TraceInsight] : [],
    );
    const satisfactionValues = members.flatMap((member) => {
      const answer = Object.hasOwn(member.labels, satisfaction)
        ? member.labels[satisfaction]
        : null;
      if (!answer || answer.error !== null || answer.value === null) return [];
      const value = answer.value;
      if (typeof value === "string" && !value.trim())
        throw new TypeError("could not convert string to float");
      const number = Number(value);
      if (Number.isNaN(number))
        throw new TypeError("could not convert value to float");
      return [number];
    });
    if (!satisfactionValues.length) continue;
    withSatisfaction++;
    let errorShare: number | null;
    if (errorsRequested) {
      const answers = members.flatMap((member) => {
        const answer = Object.hasOwn(member.labels, errors)
          ? member.labels[errors]
          : null;
        return answer && answer.error === null && answer.value !== null
          ? [answer]
          : [];
      });
      errorShare = answers.length
        ? answers.filter((answer) => answer.value === true).length /
          answers.length
        : null;
    } else {
      const summaries = members.flatMap((member) =>
        member.summary ? [member.summary] : [],
      );
      errorShare = summaries.length
        ? summaries.filter((summary) => realAssistantErrors(summary).length > 0)
            .length / summaries.length
        : null;
    }
    if (errorShare === null) {
      if (!errorsRequested) withoutSummaries++;
      continue;
    }
    points.push(
      PriorityPointSchema.parse({
        clusterId: cluster.id,
        name: cluster.name,
        volume: cluster.size,
        meanSatisfaction:
          satisfactionValues.reduce((a, b) => a + b, 0) /
          satisfactionValues.length,
        errorShare,
      }),
    );
  }
  if (!points.length) {
    const reason =
      !errorsRequested &&
      withSatisfaction > 0 &&
      withoutSummaries === withSatisfaction
        ? `no base cluster in dimension ${repr(dimension.name)} with a ${repr(satisfaction)} answer has a summary assistant_errors value`
        : `no base cluster in dimension ${repr(dimension.name)} has a ${repr(satisfaction)} answer`;
    return [null, reason];
  }
  return [points, degraded];
}
