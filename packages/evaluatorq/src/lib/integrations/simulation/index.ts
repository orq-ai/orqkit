/**
 * Agent simulation integration for evaluatorq.
 *
 * Provides tools to run multi-turn agent simulations with user simulator
 * and judge agents, convert results to OpenResponses format, and integrate
 * with the evaluatorq evaluation pipeline.
 *
 * @example
 * ```typescript
 * import { simulate, wrapSimulationAgent, toOpenResponses } from "@orq-ai/evaluatorq/simulation";
 * ```
 */

export {
  type AISdkHttpTargetOptions,
  type AISdkMessageFormat,
  VercelAISdkTarget,
} from "../ai-sdk/http-target.js";
export {
  type AgentCallable,
  CallableTarget,
  type CallableTargetOptions,
} from "../callable/index.js";
export { OrqResponsesTarget } from "../openresponses/target.js";
// --- Adapters ---
export {
  fromChatCompletions,
  fromOrqAgent,
  fromOrqDeployment,
} from "./adapters.js";
export type { AgentConfig } from "./agents/base.js";
// --- Agents (advanced usage) ---
export { BaseAgent } from "./agents/base.js";
export { JudgeAgent } from "./agents/judge.js";
export { UserSimulatorAgent } from "./agents/user-simulator.js";
export {
  executeSimRuns,
  executeSimSchema,
  executeSimValidate,
  executeSimValidateDataset,
  type SimIO,
} from "./cli.js";
export {
  executeSimExport,
  executeSimUploadDataset,
  loadResultsForExport,
  type SimDatasetsApi,
  type SimExportArgs,
  type SimExportIO,
  type SimUploadArgs,
  type SimUploadIO,
} from "./cli-export.js";
export {
  executeSimFromTraces,
  executeSimGenerate,
  type SimFromTracesArgs,
  type SimFromTracesIO,
  type SimGenerateArgs,
  type SimGenerateIO,
  toOrqDatasetRows,
} from "./cli-generate.js";
export {
  executeSimRun,
  executeSimSimulate,
  type SimRunArgs,
  type SimRunIO,
  type SimSimulateArgs,
} from "./cli-run.js";
// --- Conversion ---
export { toOpenResponses } from "./convert.js";
// --- Criteria (advanced usage) ---
export {
  buildCriteriaMeta,
  buildCriteriaResults,
  CriteriaTracker,
  criterionIdFor,
  parseCriteriaMeta,
} from "./criteria.js";
export type {
  DatasetSourceOptions,
  ExtendFromDatasetOptions,
} from "./datasets.js";
export { datapointsFromDataset, extendFromDataset } from "./datasets.js";
export { DEFAULT_SIMULATION_MODEL } from "./defaults.js";
export type {
  ConversationQualityScore,
  SimulationScorer,
  SimulationScoringConfigInput,
} from "./evaluators/index.js";
// --- Evaluators ---
export {
  conversationQualityDetails,
  DEFAULT_SCORING_CONFIG,
  failureReason,
  getAllEvaluators,
  getEvaluator,
  readCriteriaMeta,
  SIMULATION_EVALUATORS,
  SimulationScoringConfig,
  unverifiedReason,
} from "./evaluators/index.js";
export {
  SimulationCancelledError,
  SimulationDroppedError,
  SimulationError,
} from "./exceptions.js";
export type {
  ExperimentSourceOptions,
  ExtendFromExperimentOptions,
} from "./experiments.js";
export {
  datapointsFromExperiment,
  extendFromExperiment,
} from "./experiments.js";
export { FirstMessageGenerationError } from "./generators/first-message-generator.js";
// --- Generators (advanced usage) ---
export {
  DatapointGenerator,
  FirstMessageGenerator,
  PersonaGenerator,
  ScenarioGenerator,
  SimulationGenerationError,
} from "./generators/index.js";
export type { SimulationHooks, SimulationRunMeta } from "./hooks.js";
export {
  CompositeSimulationHooks,
  DefaultHooks,
  ManifestStageHooks,
  SimStage,
} from "./hooks.js";
export type { PerturbationType } from "./quality/message-perturbation.js";
// --- Quality (advanced usage) ---
export {
  applyPerturbation,
  applyPerturbationsBatch,
  applyRandomPerturbation,
} from "./quality/message-perturbation.js";
export { applySimulationSuggestions } from "./reports/apply.js";
export {
  printSimulationSummary,
  renderSimulationSummary,
} from "./reports/display.js";
export {
  buildSimulationFacts,
  populateSimulationExecutiveSummary,
} from "./reports/executive-summary.js";
export { exportSimulationHtml } from "./reports/export-html.js";
export { exportSimulationMarkdown } from "./reports/export-md.js";
export type {
  GenerateRecommendationsOptions,
  SimulationRecommendationConfigInput,
} from "./reports/recommendations.js";
export {
  findSimulationTriggers,
  generateSimulationRecommendations,
  SimulationRecommendationConfig,
} from "./reports/recommendations.js";
export {
  buildSimulationReportSections,
  simulationIndividualEntries,
} from "./reports/sections.js";
export { buildSimulationTokenUsageRows } from "./reports/token-usage.js";
export type {
  AgentInfoSnapshot,
  SimulationRecommendation,
  SimulationReplay,
  SimulationRunInput,
  StoredSimulationResult,
} from "./run-store.js";
export {
  autoSaveSimulationRun,
  buildSimulationRun,
  getSimulationRunsDir,
  loadSimulationReplay,
  ReplayError,
  SimulationRun,
  sanitiseRunName,
} from "./run-store.js";
export type {
  RunBatchParams,
  RunParams,
  SimulationJudge,
  SimulationRunnerConfig,
  SimulationUserSimulator,
  TargetAgent,
} from "./runner/simulation.js";
// --- Runner (advanced usage) ---
export { SimulationRunner } from "./runner/simulation.js";
export { wrapSimulationScorer } from "./scorer-adapter.js";
// --- Schemas ---
// Zod schemas have their own entry point: "@orq-ai/evaluatorq/simulation/schemas".
export type {
  GenerateAndSimulateParams,
  SimulateParams,
} from "./simulation/index.js";
// --- High-level simulation functions ---
export { generateAndSimulate, simulate } from "./simulation/index.js";
export type {
  DatapointsFromTracesOptions,
  ExtendFromTracesOptions,
  FetchTraceConversationsOptions,
  SimulationTraceSource,
  TraceAnalysisConfigInput,
  TraceGenerationOptions,
} from "./traces.js";
export {
  datapointsFromTraces,
  extendFromTraces,
  fetchTraceConversations,
  summarizeConversations,
  TraceAnalysisConfig,
  TraceConversation,
} from "./traces.js";
// --- Types ---
export type {
  ChatMessage,
  ChatMessage as SimulationMessage,
  CommunicationStyle,
  ConversationStrategy,
  CriteriaMeta,
  Criterion,
  CriterionVerdict,
  CulturalContext,
  Datapoint,
  EmotionalArc,
  InputFormat,
  Judgment,
  Persona,
  Scenario,
  SimulationResult,
  StartingEmotion,
  TargetCallback,
  TerminatedBy,
  TokenUsage,
  TurnMetrics,
} from "./types.js";
// --- Utils (advanced usage) ---
export {
  exportDatapointsToJsonl,
  exportResultsToJsonl,
  loadDatapointsFromJsonl,
  resultsToJsonl,
} from "./utils/dataset-export.js";
export {
  buildDatapointSystemPrompt,
  buildPersonaSystemPrompt,
  buildScenarioUserContext,
  generateDatapoint,
} from "./utils/prompt-builders.js";
export type { SimulationJob, SimulationJobOptions } from "./wrap-agent.js";
// --- Job wrapper ---
export { wrapSimulationAgent } from "./wrap-agent.js";
