// Type-only imports from ai package (stripped at compile time, no runtime errors if not installed)
import type { StepResult } from "ai";

import type { FunctionTool, ResponseResource } from "../openresponses/index.js";

// Re-export AI SDK types for consumers
export type { StepResult };

/**
 * Type definition for step data extracted from AI SDK results.
 * This interface extends the AI SDK's StepResult type with additional fields
 * that may be present in certain AI SDK versions or providers.
 */
export interface StepData {
  // Content array contains tool-call and tool-result items (ToolLoopAgent format)
  content?: Array<{
    type: string;
    toolCallId?: string;
    toolName?: string;
    input?: unknown;
    output?: unknown;
  }>;
  // Request/response details that may be present
  request?: {
    body?: {
      input?: unknown[];
      tools?: FunctionTool[];
    };
  };
  response?: {
    body?: ResponseResource;
    messages?: Array<{
      role: string;
      content: Array<{
        type: string;
        toolCallId?: string;
        toolName?: string;
        input?: unknown;
        text?: string;
        providerOptions?: {
          openai?: {
            itemId?: string;
          };
        };
      }>;
    }>;
  };
  providerMetadata?: {
    openai?: {
      itemId?: string;
    };
  };
}

/**
 * Options for creating an evaluatorq Job from an AI SDK Agent.
 */
export interface AgentJobOptions {
  /** The name of the job (defaults to agent.id or "agent") */
  name?: string;
  /** The key in data.inputs to use as the prompt (defaults to "prompt") */
  promptKey?: string;
}
