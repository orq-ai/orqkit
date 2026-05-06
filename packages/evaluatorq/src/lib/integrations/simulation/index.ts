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
// --- Conversion ---
export { toOpenResponses } from "./convert.js";
export type { SimulationScorer } from "./evaluators/index.js";
// --- Evaluators ---
export {
  getAllEvaluators,
  getEvaluator,
  SIMULATION_EVALUATORS,
} from "./evaluators/index.js";
// --- Generators (advanced usage) ---
export {
  DatapointGenerator,
  FirstMessageGenerator,
  PersonaGenerator,
  ScenarioGenerator,
} from "./generators/index.js";
export type { PerturbationType } from "./quality/message-perturbation.js";
// --- Quality (advanced usage) ---
export {
  applyPerturbation,
  applyPerturbationsBatch,
  applyRandomPerturbation,
} from "./quality/message-perturbation.js";
export type {
  RunBatchParams,
  RunParams,
  SimulationRunnerConfig,
  TargetAgent,
} from "./runner/simulation.js";
// --- Runner (advanced usage) ---
export { SimulationRunner } from "./runner/simulation.js";
// --- Schemas ---
// Zod schemas are NOT re-exported here to avoid requiring zod at import time.
// Import from "@orq-ai/evaluatorq/simulation/schemas" instead.
export type {
  GenerateAndSimulateParams,
  SimulateParams,
} from "./simulation/index.js";
// --- High-level simulation functions ---
export { generateAndSimulate, simulate } from "./simulation/index.js";
// --- Types ---
export type {
  ChatMessage,
  CommunicationStyle,
  ConversationStrategy,
  Criterion,
  CulturalContext,
  Datapoint,
  EmotionalArc,
  InputFormat,
  Judgment,
  Message as SimulationMessage,
  Persona,
  Scenario,
  SimulationResult,
  StartingEmotion,
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
export type { SimulationJobOptions } from "./wrap-agent.js";
// --- Job wrapper ---
export { wrapSimulationAgent } from "./wrap-agent.js";
