import { writeFile } from "node:fs/promises";

import { resolveLlmClient } from "../common/llm-client.js";
import { addCliModels } from "../common/model-roles.js";
import {
  listOrqProfiles,
  type OrqProfile,
  resolveOrqClient,
} from "../common/orq-client.js";
import {
  codepointCompare,
  pythonString,
  pythonStrip,
} from "../common/sanitize.js";
import { cliDebug } from "./debug.js";
import { exportJson } from "./export.js";
import {
  FACET_NAMES,
  FacetSelection,
  NumericFilters,
  PopulationRequest,
  type RunRequest,
  RunRequestSchema,
  type RunSnapshot,
  selectionRuleText,
  timeMicros,
} from "./models.js";
import { buildRunStore } from "./pipeline.js";
import { fromMicroseconds } from "./rows.js";
import type { RunStore } from "./run-store.js";
import type { DashboardSettings } from "./settings.js";
import { effectiveDashboardSettings } from "./settings.js";

export interface FindArguments {
  query: string;
  windowDaysExplicit?: boolean;
  project?: readonly string[];
  model?: readonly string[];
  provider?: readonly string[];
  status?: readonly string[];
  product?: readonly string[];
  traceType?: readonly string[];
  agent?: readonly string[];
  tool?: readonly string[];
  tokensMin?: number | null;
  tokensMax?: number | null;
  durationMsMin?: number | null;
  durationMsMax?: number | null;
}
const values = (items: readonly string[] | undefined) =>
  new Set((items ?? []).map(pythonStrip).filter(Boolean));
export function findRequest(
  args: FindArguments,
  settings: DashboardSettings,
  now: string = new Date().toISOString(),
): RunRequest {
  const start = fromMicroseconds(
    timeMicros(now) - BigInt(settings.windowDays) * 86400_000_000n,
  );
  if (start === null)
    throw new RangeError("Trace finder time window is out of range");
  return RunRequestSchema.parse({
    query: args.query,
    mode: "review",
    population: new PopulationRequest({
      start,
      end: now,
      timeOrigin: args.windowDaysExplicit ? "explicit" : "default",
      facets: new FacetSelection({
        project: values(args.project),
        projectId: args.project?.length ? null : settings.orqProjectId,
        model: values(args.model),
        provider: values(args.provider),
        status: values(args.status),
        product: values(args.product),
        traceType: values(args.traceType),
        agentName: values(args.agent),
        toolName: values(args.tool),
      }),
      numeric: new NumericFilters({
        tokensMin: args.tokensMin ?? null,
        tokensMax: args.tokensMax ?? null,
        durationMsMin: args.durationMsMin ?? null,
        durationMsMax: args.durationMsMax ?? null,
      }),
      limit: settings.limit,
    }),
    parallelism: settings.parallelism,
  });
}
const nativeFacet = (name: string) =>
  name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()) as Exclude<
    keyof FacetSelection,
    "projectId"
  >;
const number = (value: number) =>
  String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
export function findFiltersText(
  facets: FacetSelection,
  numeric: NumericFilters,
): string {
  const parts = FACET_NAMES.flatMap((name) => {
    const selected = facets[nativeFacet(name)];
    return selected.size
      ? [
          `${name.replaceAll("_", " ")}: ${[...selected].sort(codepointCompare).join(", ")}`,
        ]
      : [];
  });
  if (facets.projectId) parts.push(`project id: ${facets.projectId}`);
  for (const [key, name] of [
    ["tokensMin", "tokens min"],
    ["tokensMax", "tokens max"],
    ["durationMsMin", "duration ms min"],
    ["durationMsMax", "duration ms max"],
  ] as const) {
    const value = numeric[key];
    if (value !== null) parts.push(`${name}: ${number(value)}`);
  }
  return parts.join("; ") || "none";
}
export function findPlanRows(snapshot: RunSnapshot): [string, string][] {
  const request = snapshot.request,
    rows: [string, string][] = [];
  if (request) {
    rows.push(["Question", request.query]);
    const { start, end } = request.population;
    if (start && end)
      rows.push([
        "Window",
        `${new Date(start).toISOString().slice(0, 16).replace("T", " ")} to ${new Date(end).toISOString().slice(0, 16).replace("T", " ")} UTC`,
      ]);
  }
  rows.push(
    [
      "Your filters",
      findFiltersText(snapshot.explicitFilters, snapshot.explicitNumeric),
    ],
    [
      "Filters from question",
      findFiltersText(snapshot.generatedFilters, snapshot.generatedNumeric),
    ],
  );
  for (const dimension of snapshot.dimensions ?? []) {
    const [lead, value] = selectionRuleText(dimension);
    rows.push([
      `Dimension: ${dimension.name}`,
      `${dimension.task.instructions}\nIncluded when: ${lead} ${value}`,
    ]);
  }
  rows.push([
    "Traces",
    `${number(snapshot.total)}${request && snapshot.total >= request.population.limit ? " (the trace limit; more traces may match)" : ""}`,
  ]);
  if (snapshot.filterSelectionError)
    rows.push([
      "Filter warning",
      `No filters from the question: ${snapshot.filterSelectionError}`,
    ]);
  if (snapshot.planWarning) rows.push(["Plan warning", snapshot.planWarning]);
  return rows;
}
export interface FindRunOptions {
  yes?: boolean;
  confirm: (
    rows: readonly [string, string][],
    snapshot: RunSnapshot,
  ) => boolean | Promise<boolean>;
  showPlan?: (rows: readonly [string, string][], snapshot: RunSnapshot) => void;
  progress?: (snapshot: RunSnapshot) => void;
  timeoutMs?: number;
  pollMs?: number;
}
export async function runFind(
  store: RunStore,
  request: RunRequest,
  options: FindRunOptions,
): Promise<RunSnapshot | null> {
  const timeout = options.timeoutMs ?? 7200000,
    pollMs = options.pollMs ?? 500;
  const poll = async (
    initial: RunSnapshot,
    active: ReadonlySet<string>,
    budget: number,
  ) => {
    let current = initial;
    const started = performance.now();
    let previous = "";
    while (active.has(current.state)) {
      const key = JSON.stringify([
        current.state,
        current.completed,
        current.total,
        current.matched,
        current.failed,
      ]);
      if (key !== previous) {
        options.progress?.(current);
        previous = key;
      }
      const remaining = budget - (performance.now() - started);
      if (remaining <= 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const cancelled = await Promise.race([
            store.cancel().then(() => true),
            new Promise<false>((resolve) => {
              timer = setTimeout(() => resolve(false), 10000);
            }),
          ]);
          if (!cancelled)
            console.warn(
              "Trace finder cancellation did not complete within 10 seconds after the CLI wait limit",
            );
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
        throw new Error(
          "Find run exceeded the combined planning and classification limit of 7,200 seconds.",
        );
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(pollMs, remaining)),
      );
      current = await store.snapshotForRender();
    }
    return store.snapshot();
  };
  const started = performance.now();
  let current = await store.compile(request, { wait: false });
  current = await poll(current, new Set(["compiling"]), timeout);
  if (current.state !== "awaiting_review") return current;
  const planning = performance.now() - started,
    dimensions = current.dimensions ?? [],
    rows = findPlanRows(current);
  options.showPlan?.(rows, current);
  if (
    !options.yes &&
    dimensions.length &&
    !(await options.confirm(rows, current))
  )
    return null;
  if (!current.request) throw new Error("Review request is missing.");
  current = await store.start(current.request, dimensions, { wait: false });
  return poll(
    current,
    new Set(["compiling", "classifying"]),
    Math.max(0, timeout - planning),
  );
}

export interface FindCommandArguments extends FindArguments {
  yes?: boolean;
  debug?: boolean;
  profile?: string;
  windowDays?: number;
  filterSelection?: "llm" | "llm+jev";
  limit?: number;
  parallelism?: number;
  compilerModel?: string;
  classifierModel?: string;
  jsonPath?: string;
  positiveOnly?: boolean;
}
export interface FindCommandIO {
  print: (message: string) => void;
  confirm: (
    rows: readonly [string, string][],
    snapshot: RunSnapshot,
  ) => boolean | Promise<boolean>;
  interactive: boolean;
}
export async function executeFind(
  args: FindCommandArguments,
  io: FindCommandIO,
): Promise<number> {
  let settings = await effectiveDashboardSettings({
    windowDays: args.windowDays,
    filterSelection: args.filterSelection,
    limit: args.limit,
    parallelism: args.parallelism,
  });
  if (settings.orqAuthMethod === "cli_oauth")
    settings = settings.withUpdates(
      { orqWorkspace: null, orqProjectId: null, orqProjectName: null },
      { persistent: false },
    );
  addCliModels(
    null,
    Object.fromEntries(
      [
        ["finder.compiler", args.compilerModel],
        ["finder.classifier", args.classifierModel],
      ].filter((pair): pair is [string, string] => Boolean(pair[1])),
    ),
  );
  const profileName =
    args.profile ??
    (settings.orqAuthMethod === "cli_profile" ? settings.orqProfile : null);
  let profile: OrqProfile | undefined;
  if (profileName) {
    profile = (await listOrqProfiles()).find(
      (item) => item.name === profileName,
    );
    if (!profile)
      throw new Error(
        `Orq profile '${profileName}' is unavailable. Check \`orq auth profile list\`.`,
      );
    if (profile.apiKey.includes("*"))
      throw new Error(
        `Orq profile '${profileName}' has a masked key that evaluatorq cannot read. Run \`orq doctor --fix\` or use ORQ_API_KEY.`,
      );
  }
  const host = profile?.server ?? undefined,
    orq = await resolveOrqClient(profile?.apiKey, host),
    resolved = await resolveLlmClient(null, {
      extraApiKey: profile?.apiKey,
      orqHost: host,
      requireOrq: true,
      maxRetries: 0,
    });
  const request = findRequest(
    { ...args, windowDaysExplicit: args.windowDays !== undefined },
    settings,
  );
  const store = buildRunStore(settings, { client: resolved.client, orq });
  let result: RunSnapshot | null;
  try {
    result = await cliDebug({ active: args.debug ?? false }, () =>
      runFind(store, request, {
        yes: args.yes || !io.interactive,
        confirm: io.confirm,
        showPlan: (rows) => {
          io.print("Find plan");
          for (const [label, value] of rows) io.print(`${label}: ${value}`);
        },
        progress: args.debug
          ? (view) =>
              io.print(
                `${view.state.toUpperCase().padStart(11)}  ${number(view.completed)}/${number(view.total)} judged  ${number(view.matched)} matched  ${number(view.failed)} failed`,
              )
          : undefined,
      }),
    );
  } finally {
    await store.close();
  }
  if (result === null) {
    io.print("Cancelled; no traces were classified.");
    return 0;
  }
  if (result.state !== "completed" || result.failed) {
    throw new Error(
      result.error ??
        (result.failed
          ? `Find run completed with ${result.failed} failed classifications.`
          : null) ??
        result.planWarning ??
        `Find run ended in ${result.state}.`,
    );
  }
  if (args.jsonPath)
    await writeFile(
      args.jsonPath,
      exportJson(result, { matchedOnly: args.positiveOnly }),
      "utf8",
    );
  const byId = new Map(result.traces.map((trace) => [trace.traceId, trace]));
  const matches = Object.values(result.results)
    .flatMap((classification) => {
      const trace = byId.get(classification.traceId);
      return trace && classification.matched && classification.error === null
        ? [{ trace, classification }]
        : [];
    })
    .sort((a, b) =>
      timeMicros(a.trace.timestamp) > timeMicros(b.trace.timestamp)
        ? -1
        : timeMicros(a.trace.timestamp) < timeMicros(b.trace.timestamp)
          ? 1
          : 0,
    );
  if (matches.length) {
    io.print(
      [
        "Trace ID",
        ...(result.dimensions ?? []).map((d) => d.name),
        "Project",
        "Model",
        "Time",
      ].join("\t"),
    );
    for (const { trace, classification } of matches) {
      const verdicts = classification.answers.map((answer) => {
        const value = answer.value === null ? "-" : pythonString(answer.value);
        return answer.confidence === null
          ? value
          : `${value} (${answer.confidence.toFixed(2)})`;
      });
      io.print(
        [
          trace.traceId,
          ...verdicts,
          trace.project,
          trace.model,
          trace.timestamp
            .replace(/\.\d+(?=Z|[+-]\d\d:\d\d$)/, "")
            .replace(/Z$/, "+00:00"),
        ].join("\t"),
      );
    }
  } else io.print("No matching traces.");
  io.print(
    `Summary: ${number(result.matched)} matched of ${number(result.total)}; ${number(result.failed)} failed.`,
  );
  return 0;
}
