import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { resolveLlmClient } from "../common/llm-client.js";
import { listOrqProfiles, resolveOrqClient } from "../common/orq-client.js";
import { sessionQuery } from "../local-sessions/cli.js";
import { searchSessions } from "../local-sessions/search.js";
import { buildSessionSnapshot } from "../local-sessions/snapshot.js";
import { effectiveDashboardSettings } from "../trace-finder/settings.js";
import { type DimensionName, InsightsPopulation, LabelSpec } from "./models.js";
import {
  type InsightsOptions,
  insights,
  prepareInsightsConfig,
} from "./pipeline.js";
import {
  describeLocalSend,
  projectionCoverage,
  readSnapshot,
  snapshotDocuments,
} from "./population.js";
import { CODING_CONVERSATION_LABELS } from "./presets.js";

export interface InsightsCommandArguments {
  sessions?: boolean;
  source?: string[];
  from?: string;
  to?: string;
  projectDir?: string;
  text?: string;
  query?: string;
  fromFinder?: string;
  fromSnapshot?: string;
  previewInput?: boolean;
  label?: string[];
  dimension?: string[];
  priorityDimension?: string;
  maxClusters?: number;
  maxSubclusters?: number;
  outlierZscore?: number;
  summaryModel?: string;
  classifierModel?: string;
  embeddingModel?: string;
  compilerModel?: string;
  cache?: boolean;
  coding?: boolean;
  json?: string;
  windowDays?: number;
  limit?: number;
  parallelism?: number;
  filterSelection?: "llm" | "llm+jev";
  profile?: string;
  project?: string[];
  model?: string[];
  provider?: string[];
  status?: string[];
  product?: string[];
  traceType?: string[];
  agent?: string[];
  tool?: string[];
  tokensMin?: number;
  tokensMax?: number;
  durationMsMin?: number;
  durationMsMax?: number;
}
export async function executeInsights(
  args: InsightsCommandArguments,
  io: { print: (message: string) => void },
): Promise<number> {
  if (args.sessions) {
    const incompatible = [
      args.query,
      args.fromFinder,
      args.fromSnapshot,
      args.windowDays,
      args.filterSelection,
      args.project,
      args.model,
      args.provider,
      args.status,
      args.product,
      args.traceType,
      args.agent,
      args.tool,
      args.tokensMin,
      args.tokensMax,
      args.durationMsMin,
      args.durationMsMax,
    ];
    if (incompatible.some((value) => value !== undefined))
      throw new Error(
        "--sessions cannot be combined with trace population options",
      );
    const result = await searchSessions(
      sessionQuery(
        {
          source: args.source,
          from: args.from,
          to: args.to,
          projectDir: args.projectDir,
          text: args.text,
          limit: args.limit,
        },
        1000,
      ),
    );
    if (!result.complete)
      io.print(
        `Session search stopped after ${result.scannedFiles} of ${result.candidateFiles} files; narrow the search to see the rest.`,
      );
    const frozen = await buildSessionSnapshot(
      result.sessions.map((session) => ({
        source: session.source,
        path: session.path,
      })),
    );
    for (const [, reason] of frozen.failed) io.print(`Skipped ${reason}`);
    const directory = await mkdtemp(
      join(tmpdir(), "evaluatorq-insights-sessions-"),
    );
    try {
      const path = join(directory, "sessions.json");
      await writeFile(path, frozen.data, { mode: 0o600, flag: "wx" });
      const {
        sessions: _sessions,
        source: _source,
        from: _from,
        to: _to,
        projectDir: _projectDir,
        text: _text,
        limit: _limit,
        ...rest
      } = args;
      return await executeInsights({ ...rest, fromSnapshot: path }, io);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  if (args.source || args.from || args.to || args.projectDir || args.text)
    throw new Error("session filters require --sessions");

  if (args.query !== undefined && !args.query.trim())
    throw new Error("--query must not be empty");
  const sources = [args.fromFinder, args.fromSnapshot, args.query].filter(
    (value) => value !== undefined,
  );
  if (sources.length > 1)
    throw new Error(
      "--query, --from-finder and --from-snapshot are mutually exclusive",
    );
  const filters = [
    args.windowDays,
    args.limit,
    args.filterSelection,
    args.project,
    args.model,
    args.provider,
    args.status,
    args.product,
    args.traceType,
    args.agent,
    args.tool,
    args.tokensMin,
    args.tokensMax,
    args.durationMsMin,
    args.durationMsMax,
  ];
  if (
    (args.fromFinder || args.fromSnapshot) &&
    filters.some((value) => value !== undefined)
  )
    throw new Error("file populations cannot be combined with trace filters");
  if (args.previewInput && !args.fromSnapshot)
    throw new Error("--preview-input requires --from-snapshot");
  const dimensions = (args.dimension ?? [
    "intent",
    "failure",
    "sentiment",
  ]) as DimensionName[];
  if (
    dimensions.some(
      (item) => !["intent", "failure", "sentiment"].includes(item),
    ) ||
    new Set(dimensions).size !== dimensions.length
  )
    throw new Error(
      "dimensions must be unique and chosen from intent, failure, sentiment",
    );
  const priorityDimension = (args.priorityDimension ??
    (dimensions.includes("intent")
      ? "intent"
      : (dimensions[0] ?? "intent"))) as DimensionName;
  if (!["intent", "failure", "sentiment"].includes(priorityDimension))
    throw new Error("invalid priority dimension");
  const labels: (LabelSpec | string)[] = [];
  for (const value of args.label ?? []) {
    if (value.endsWith(".json"))
      labels.push(new LabelSpec(JSON.parse(await readFile(value, "utf8"))));
    else labels.push(value);
  }
  const settings = await effectiveDashboardSettings({
    windowDays: args.windowDays,
    limit: args.limit,
    parallelism: args.parallelism,
    filterSelection: args.filterSelection,
  });
  const configOptions: InsightsOptions = {
    labels,
    dimensions,
    priorityDimension,
    maxClusters: args.maxClusters,
    maxSubclusters: args.maxSubclusters,
    outlierZscore: args.outlierZscore,
    summaryModel: args.summaryModel,
    classifierModel: args.classifierModel,
    compilerModel: args.compilerModel,
    embeddingModel: args.embeddingModel,
    cache: args.cache,
    codingAnalysis: args.coding,
    parallelism: settings.parallelism,
    traceInputChars: settings.traceInputChars,
  };
  const prepared = await prepareInsightsConfig(configOptions);
  const population = args.fromSnapshot
    ? InsightsPopulation.fromSnapshot(args.fromSnapshot)
    : args.fromFinder
      ? InsightsPopulation.fromFinderExport(args.fromFinder)
      : new InsightsPopulation({
          query: args.query ?? null,
          windowDays: settings.windowDays,
          timeOrigin: args.windowDays === undefined ? "default" : "explicit",
          limit: settings.limit,
          filterSelection: args.filterSelection ?? null,
          facets: {
            project: args.project ?? [],
            model: args.model ?? [],
            provider: args.provider ?? [],
            status: args.status ?? [],
            product: args.product ?? [],
            traceType: args.traceType ?? [],
            agentName: args.agent ?? [],
            toolName: args.tool ?? [],
          },
          numeric: {
            tokensMin: args.tokensMin ?? null,
            tokensMax: args.tokensMax ?? null,
            durationMsMin: args.durationMsMin ?? null,
            durationMsMax: args.durationMsMax ?? null,
          },
        });
  if (args.fromSnapshot) {
    const { snapshot } = await readSnapshot(args.fromSnapshot),
      traces = snapshotDocuments(snapshot),
      questions = Object.fromEntries(
        prepared.config.labels.map((spec) => [spec.name, spec.toQuestion({})]),
      );
    if (!traces.length)
      throw new Error("local trace snapshot contains no traces");
    if (args.coding)
      for (const spec of CODING_CONVERSATION_LABELS)
        questions[spec.name] = spec.toQuestion({});
    const coverage = await projectionCoverage(traces, {
      traceInputChars: settings.traceInputChars,
      classifierModel: prepared.config.classifierModel,
      classifierQuestions: questions,
    });
    io.print(
      `${coverage.nProjectionTruncated} of ${coverage.nTraces} traces hit a summary or classifier input cap of ${coverage.traceInputChars} characters.`,
    );
    io.print(
      describeLocalSend({
        nTraces: traces.length,
        nBytes: (await stat(args.fromSnapshot)).size,
        fileName: args.fromSnapshot,
        models: {
          summary: prepared.config.summaryModel,
          classifier: prepared.config.classifierModel,
          embedding: prepared.config.embeddingModel,
        },
        preview: args.previewInput,
      }),
    );
    if (args.previewInput) return 0;
  }
  const profileName =
    args.profile ??
    (!args.fromSnapshot && settings.orqAuthMethod === "cli_profile"
      ? settings.orqProfile
      : null);
  if (profileName) {
    const profile = (await listOrqProfiles()).find(
      (item) => item.name === profileName,
    );
    if (!profile || profile.apiKey.includes("*"))
      throw new Error(
        `Orq profile '${profileName}' is unavailable or has a masked key`,
      );
    const host = profile.server ?? undefined;
    if (!args.fromSnapshot)
      configOptions.orqClient = await resolveOrqClient(profile.apiKey, host);
    configOptions.llmClient = (
      await resolveLlmClient(null, {
        extraApiKey: profile.apiKey,
        orqHost: host,
        requireOrq: true,
        maxRetries: 0,
      })
    ).client;
  }
  let saved = "";
  const run = await insights(population, {
    ...configOptions,
    onSaved: (path) => {
      saved = path;
    },
  });
  if (args.json) {
    await mkdir(dirname(args.json), { recursive: true });
    await writeFile(
      args.json,
      `${JSON.stringify(run, (_key, value) => (value instanceof Set ? [...value] : value), 2)}\n`,
      "utf8",
    );
  }
  io.print(`Insights ${run.status}: ${run.traces.length} traces`);
  for (const warning of run.warnings) io.print(`Warning: ${warning}`);
  for (const failure of run.stageFailures)
    io.print(`${failure.stage}: ${failure.message}`);
  if (saved) io.print(`Saved: ${saved}`);
  return run.status === "error" ? 1 : 0;
}
