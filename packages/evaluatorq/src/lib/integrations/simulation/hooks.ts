import {
  combineConfirm,
  fanOut,
  warnIfSyncHooks,
} from "../../common/async-utils.js";
import type { ManifestWriter } from "../../common/run-manifest.js";
import type { Datapoint, SimulationResult, TurnMetrics } from "./types.js";

export enum SimStage {
  Generate = "generate",
  Simulate = "simulate",
}
export interface SimulationRunMeta {
  numDatapoints: number;
  model: string;
  maxTurns: number;
  datapointParallelism: number;
  evaluationName: string;
  evaluatorNames: string[];
  target: string;
}
type MaybeAsync<T> = T | Promise<T>;
export interface SimulationHooks {
  onConfirm?(meta: SimulationRunMeta): MaybeAsync<boolean>;
  onRunStart?(meta: SimulationRunMeta): MaybeAsync<void>;
  onStageStart?(
    stage: SimStage | string,
    meta: Record<string, unknown>,
  ): MaybeAsync<void>;
  onStageEnd?(
    stage: SimStage | string,
    meta: Record<string, unknown>,
  ): MaybeAsync<void>;
  onGenerateInputsReady?(
    numPersonas: number,
    numScenarios: number,
  ): MaybeAsync<void>;
  onDatapointStart?(datapoint: Datapoint): MaybeAsync<void>;
  onTurnComplete?(datapointId: string, metrics: TurnMetrics): MaybeAsync<void>;
  onDatapointComplete?(result: SimulationResult): MaybeAsync<void>;
  onEvaluatorComplete?(
    datapointId: string,
    name: string,
    score: unknown,
  ): MaybeAsync<void>;
  onDatapointError?(datapoint: Datapoint, error: unknown): MaybeAsync<void>;
  onRunComplete?(results: SimulationResult[]): MaybeAsync<void>;
}

export class DefaultHooks implements SimulationHooks {
  async onConfirm(_meta: SimulationRunMeta): Promise<boolean> {
    return true;
  }
  async onRunStart(_meta: SimulationRunMeta): Promise<void> {}
  async onStageStart(
    _stage: string,
    _meta: Record<string, unknown>,
  ): Promise<void> {}
  async onStageEnd(
    _stage: string,
    _meta: Record<string, unknown>,
  ): Promise<void> {}
  async onGenerateInputsReady(
    _numPersonas: number,
    _numScenarios: number,
  ): Promise<void> {}
  async onDatapointStart(_datapoint: Datapoint): Promise<void> {}
  async onTurnComplete(
    _datapointId: string,
    _metrics: TurnMetrics,
  ): Promise<void> {}
  async onDatapointComplete(_result: SimulationResult): Promise<void> {}
  async onEvaluatorComplete(
    _datapointId: string,
    _name: string,
    _score: unknown,
  ): Promise<void> {}
  async onDatapointError(
    _datapoint: Datapoint,
    _error: unknown,
  ): Promise<void> {}
  async onRunComplete(_results: SimulationResult[]): Promise<void> {}
}

export class CompositeSimulationHooks extends DefaultHooks {
  constructor(readonly children: readonly SimulationHooks[]) {
    super();
    const methods = Object.getOwnPropertyNames(DefaultHooks.prototype).filter(
      (name) => name.startsWith("on"),
    );
    for (const child of children) warnIfSyncHooks(child, methods);
  }
  override async onConfirm(meta: SimulationRunMeta): Promise<boolean> {
    return combineConfirm(
      this.children.filter((child) => child.onConfirm),
      meta,
    );
  }
  override async onRunStart(meta: SimulationRunMeta): Promise<void> {
    await fanOut(
      this.children.filter((child) => child.onRunStart),
      "onRunStart",
      meta,
    );
  }
  override async onStageStart(
    stage: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await fanOut(
      this.children.filter((child) => child.onStageStart),
      "onStageStart",
      stage,
      meta,
    );
  }
  override async onStageEnd(
    stage: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await fanOut(
      this.children.filter((child) => child.onStageEnd),
      "onStageEnd",
      stage,
      meta,
    );
  }
  override async onGenerateInputsReady(
    personas: number,
    scenarios: number,
  ): Promise<void> {
    await fanOut(
      this.children.filter((child) => child.onGenerateInputsReady),
      "onGenerateInputsReady",
      personas,
      scenarios,
    );
  }
  override async onDatapointStart(datapoint: Datapoint): Promise<void> {
    await fanOut(
      this.children.filter((child) => child.onDatapointStart),
      "onDatapointStart",
      datapoint,
    );
  }
  override async onTurnComplete(
    id: string,
    metrics: TurnMetrics,
  ): Promise<void> {
    await fanOut(
      this.children.filter((child) => child.onTurnComplete),
      "onTurnComplete",
      id,
      metrics,
    );
  }
  override async onDatapointComplete(result: SimulationResult): Promise<void> {
    await fanOut(
      this.children.filter((child) => child.onDatapointComplete),
      "onDatapointComplete",
      result,
    );
  }
  override async onEvaluatorComplete(
    id: string,
    name: string,
    score: unknown,
  ): Promise<void> {
    await fanOut(
      this.children.filter((child) => child.onEvaluatorComplete),
      "onEvaluatorComplete",
      id,
      name,
      score,
    );
  }
  override async onDatapointError(
    datapoint: Datapoint,
    error: unknown,
  ): Promise<void> {
    await fanOut(
      this.children.filter((child) => child.onDatapointError),
      "onDatapointError",
      datapoint,
      error,
    );
  }
  override async onRunComplete(results: SimulationResult[]): Promise<void> {
    await fanOut(
      this.children.filter((child) => child.onRunComplete),
      "onRunComplete",
      results,
    );
  }
}

export class ManifestStageHooks extends DefaultHooks {
  constructor(readonly writer: ManifestWriter) {
    super();
  }
  override async onStageStart(
    stage: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await this.writer.startStage(stage, meta);
  }
  override async onStageEnd(
    stage: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await this.writer.endStage(stage, meta);
  }
}
