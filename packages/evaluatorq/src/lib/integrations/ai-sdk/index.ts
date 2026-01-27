// Re-export common utilities for backwards compatibility
export { generateItemId } from "../common/index.js";
export {
  buildInputFromSteps,
  buildOpenResponsesFromSteps,
  convertToOpenResponses,
} from "./convert.js";
export type { AgentJobOptions, StepData } from "./types.js";
export { wrapAISdkAgent } from "./wrap-agent.js";
