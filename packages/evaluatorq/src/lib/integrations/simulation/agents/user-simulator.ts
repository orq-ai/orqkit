/**
 * User simulator agent.
 *
 * Simulates user behavior based on a persona and scenario,
 * generating realistic user messages in conversations.
 */

import type { ChatMessage } from "../types.js";
import type { AgentConfig } from "./base.js";
import { BaseAgent } from "./base.js";

// ---------------------------------------------------------------------------
// Default user simulator system prompt
// ---------------------------------------------------------------------------

export const DEFAULT_USER_SIMULATOR_PROMPT = `You are a user simulator. Your role is to simulate realistic user behavior in a conversation with an AI agent.

You will be given:
1. A persona describing who you are and how you behave
2. A scenario describing your goal and context

Your task:
- Generate realistic user messages based on your persona and scenario
- Stay in character throughout the conversation
- Work towards achieving your goal naturally
- React authentically to the agent's responses
- Do not break character or acknowledge that you are a simulation

Response format:
- Respond only with the user's message
- Do not include any meta-commentary or explanations
- Keep responses natural and conversational`;

// ---------------------------------------------------------------------------
// UserSimulatorAgent configuration
// ---------------------------------------------------------------------------

export interface UserSimulatorAgentConfig extends AgentConfig {
  /** Custom system prompt to append to the default prompt. */
  systemPrompt?: string;
}

// ---------------------------------------------------------------------------
// UserSimulatorAgent
// ---------------------------------------------------------------------------

/**
 * Agent that simulates user behavior.
 *
 * Uses a persona and scenario to generate realistic user messages
 * in a conversation with the agent being tested.
 */
export class UserSimulatorAgent extends BaseAgent {
  private customSystemPrompt: string | null;

  constructor(config?: UserSimulatorAgentConfig) {
    super(config);
    this.customSystemPrompt = config?.systemPrompt ?? null;
  }

  get name(): string {
    return "UserSimulator";
  }

  get systemPrompt(): string {
    if (this.customSystemPrompt) {
      return `${DEFAULT_USER_SIMULATOR_PROMPT}\n\n---\n\n${this.customSystemPrompt}`;
    }
    return DEFAULT_USER_SIMULATOR_PROMPT;
  }

  /**
   * Generate the first message to start a conversation.
   *
   * @param messages - Optional context messages
   * @returns First user message to start the conversation
   */
  async generateFirstMessage(messages?: ChatMessage[]): Promise<string> {
    const promptMessages: ChatMessage[] = [...(messages ?? [])];
    promptMessages.push({
      role: "user",
      content:
        "Generate your first message to start the conversation. Remember your goal and persona.",
    });

    return this.respondAsync(promptMessages, {
      temperature: 0.8,
      llmPurpose: "first_message",
    });
  }

  /**
   * Update the persona and scenario context.
   *
   * @param personaContext  - Persona-specific context
   * @param scenarioContext - Scenario-specific context
   */
  updateContext(personaContext?: string, scenarioContext?: string): void {
    let combined = "";
    if (personaContext) {
      combined += `PERSONA:\n${personaContext}\n\n`;
    }
    if (scenarioContext) {
      combined += `SCENARIO:\n${scenarioContext}`;
    }

    this.customSystemPrompt = combined.trim() || null;
  }
}
