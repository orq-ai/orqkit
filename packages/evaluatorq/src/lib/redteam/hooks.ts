import { dirname } from "node:path";

import {
  combineConfirm,
  fanOut,
  type MaybeAsync,
  warnIfSyncHooks,
} from "../common/async-utils.js";
import { pct } from "../common/reports/html-helpers.js";
import type { ManifestWriter } from "../common/run-manifest.js";
import type { AgentContext } from "../contracts.js";
import { PipelineStage } from "./contracts.js";
import type { RedTeamReport } from "./reports/models.js";

export interface ConfirmPayload {
  agentContext?: AgentContext | null;
  agentContexts?: Record<string, AgentContext> | null;
  numDatapoints?: number;
  numDynamic?: number | null;
  numStatic?: number | null;
  categories?: string[];
  attackModel?: string;
  evaluatorModel?: string;
  maxTurns?: number;
  datapointParallelism?: number;
  filteringMetadata?: Record<string, unknown> | null;
  strategyBreakdown?: Record<string, unknown> | null;
  mode?: string;
  target?: string;
  datasetPath?: string | null;
  vulnerabilities?: string[] | null;
  replayOf?: string | null;
}
export interface PipelineCompletionOptions {
  outputDir?: string | null;
  autoSavePath?: string | null;
}
export interface PipelineHooks {
  onStageStart(
    stage: PipelineStage | string,
    meta: Record<string, unknown>,
  ): MaybeAsync<void>;
  onStageEnd(
    stage: PipelineStage | string,
    meta: Record<string, unknown>,
  ): MaybeAsync<void>;
  onConfirm(payload: ConfirmPayload): MaybeAsync<boolean>;
  onComplete(
    report: RedTeamReport,
    options?: PipelineCompletionOptions,
  ): MaybeAsync<void>;
}
export const PIPELINE_HOOK_METHODS = [
  "onStageStart",
  "onStageEnd",
  "onConfirm",
  "onComplete",
] as const;
const stageLabels: Record<string, string> = {
  [PipelineStage.CONTEXT_RETRIEVAL]: "Retrieving Agent Context",
  [PipelineStage.DATAPOINT_GENERATION]: "Generating Attack Datapoints",
  [PipelineStage.ATTACK_EXECUTION]: "Executing Attacks",
  [PipelineStage.REPORT_GENERATION]: "Generating Report",
  [PipelineStage.CLEANUP]: "Cleaning Up",
  [PipelineStage.TARGET_START]: "Starting Target",
  [PipelineStage.TARGET_COMPLETE]: "Target Complete",
};
function shellPath(path: string): string {
  return path && /^[a-zA-Z0-9_@%+=:,./-]+$/.test(path)
    ? path
    : `'${path.replaceAll("'", `'"'"'`)}'`;
}
export class DefaultHooks implements PipelineHooks {
  async onStageStart(
    stage: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    console.info(
      `[redteam] Stage started: ${stage} - ${stageLabels[stage] ?? stage} | meta=${JSON.stringify(meta)}`,
    );
  }
  async onStageEnd(
    stage: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    if (stage === PipelineStage.DATAPOINT_GENERATION) {
      if (meta.numDynamic != null && meta.numStatic != null)
        console.info(
          `[redteam] Generated ${Number(meta.numDynamic || 0) + Number(meta.numStatic || 0)} datapoints (${meta.numDynamic || 0} dynamic + ${meta.numStatic || 0} static)`,
        );
      else if (meta.numDatapoints != null)
        console.info(`[redteam] Generated ${meta.numDatapoints} datapoints`);
    }
    console.info(
      `[redteam] Stage complete: ${stage} - ${stageLabels[stage] ?? stage} | meta=${JSON.stringify(meta)}`,
    );
  }
  async onConfirm(payload: ConfirmPayload): Promise<boolean> {
    const categories = payload.categories ?? [],
      count = payload.numDatapoints ?? "?";
    const detail =
      payload.numDynamic != null && payload.numStatic != null
        ? `${count} datapoints (${payload.numDynamic} dynamic + ${payload.numStatic} static)`
        : `${count} datapoints`;
    console.info(
      `[redteam] Run plan: ${detail} | ${categories.length} ${categories.length === 1 ? "category" : "categories"} | mode=${JSON.stringify(payload.mode ?? "?")} | target=${JSON.stringify(payload.target ?? "?")} | attack_model=${JSON.stringify(payload.attackModel ?? "?")} | evaluator_model=${JSON.stringify(payload.evaluatorModel ?? "?")}`,
    );
    return true;
  }
  async onComplete(
    report: RedTeamReport,
    options: PipelineCompletionOptions = {},
  ): Promise<void> {
    for (const warning of report.pipelineWarnings)
      console.warn(`[redteam] PIPELINE WARNING: ${warning}`);
    const summary = report.summary;
    if (summary.noVerdict)
      console.error(
        `[redteam] Run complete - NO VERDICT: 0/${summary.totalAttacks} attacks could be evaluated. The target was not tested.`,
      );
    else
      console.info(
        `[redteam] Run complete - resistance_rate=${pct(summary.resistanceRate)} (${summary.evaluatedAttacks}/${summary.totalAttacks} evaluated) vulnerabilities=${summary.vulnerabilitiesFound} attacks=${summary.totalAttacks}`,
      );
    const directory =
      options.outputDir ||
      (options.autoSavePath
        ? dirname(options.autoSavePath)
        : ".evaluatorq/runs");
    console.info(
      `[redteam] Tip: visualise results with  "eq dashboard ${shellPath(directory)}"`,
    );
  }
}
export class CompositePipelineHooks implements PipelineHooks {
  readonly children: readonly PipelineHooks[];
  constructor(children: Iterable<PipelineHooks>) {
    this.children = [...children];
    for (const child of this.children)
      warnIfSyncHooks(child, PIPELINE_HOOK_METHODS);
  }
  async onStageStart(
    stage: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await fanOut(this.children, "onStageStart", stage, meta);
  }
  async onStageEnd(
    stage: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await fanOut(this.children, "onStageEnd", stage, meta);
  }
  async onConfirm(payload: ConfirmPayload): Promise<boolean> {
    return combineConfirm(this.children, payload);
  }
  async onComplete(
    report: RedTeamReport,
    options: PipelineCompletionOptions = {},
  ): Promise<void> {
    await fanOut(this.children, "onComplete", report, options);
  }
}
export class ManifestStageHooks implements PipelineHooks {
  constructor(readonly writer: ManifestWriter) {}
  async onStageStart(
    stage: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await this.writer.startStage(stage, {
      target: meta.target as string | null | undefined,
    });
  }
  async onStageEnd(
    stage: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await this.writer.endStage(stage, {
      target: meta.target as string | null | undefined,
      error: meta.error,
    });
  }
  async onConfirm(_payload: ConfirmPayload): Promise<boolean> {
    return true;
  }
  async onComplete(
    _report: RedTeamReport,
    _options: PipelineCompletionOptions = {},
  ): Promise<void> {}
}
