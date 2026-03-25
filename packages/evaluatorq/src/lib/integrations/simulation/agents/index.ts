/**
 * Agent exports for the simulation framework.
 */

export type { AgentConfig, LLMResult } from "./base.js";
export { BaseAgent } from "./base.js";
export type { JudgeAgentConfig } from "./judge.js";
export { DEFAULT_JUDGE_PROMPT, JUDGE_TOOLS, JudgeAgent } from "./judge.js";
export type { UserSimulatorAgentConfig } from "./user-simulator.js";
export {
  DEFAULT_USER_SIMULATOR_PROMPT,
  UserSimulatorAgent,
} from "./user-simulator.js";
