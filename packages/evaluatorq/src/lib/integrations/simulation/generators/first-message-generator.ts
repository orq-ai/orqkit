/**
 * First message generator using LLM.
 *
 * Generates contextually appropriate first messages based on persona and scenario.
 */

import OpenAI from "openai";

import type { Persona, Scenario } from "../types.js";
import {
  buildPersonaSystemPrompt,
  buildScenarioUserContext,
} from "../utils/prompt-builders.js";

// Temperature setting for message generation
const TEMPERATURE_FIRST_MESSAGE = 0.8;

const FIRST_MESSAGE_PROMPT = `You are generating the authentic first message a user would type to a support agent.

## Your Task
Create a realistic opening message that sounds like an ACTUAL customer, not a script.

## Guidelines

### Voice Matching (based on persona traits):
- **Communication style "terse"**: Short sentences, minimal pleasantries, gets straight to the point
- **Communication style "verbose"**: Detailed explanations, context, multiple sentences
- **Communication style "formal"**: Professional language, complete sentences, "Dear", "Sincerely"
- **Communication style "casual"**: Contractions, slang, emojis if appropriate, friendly tone

- **Low patience (0-0.3)**: Frustrated tone, urgency indicators ("I've been waiting", "This is ridiculous")
- **High patience (0.7-1.0)**: Calm, understanding, may apologize for bothering

- **Low politeness (0-0.3)**: Direct, potentially demanding, no pleasantries
- **High politeness (0.7-1.0)**: "Please", "Thank you", "I appreciate your help"

- **Low technical level (0-0.3)**: Simple language, may describe problems in non-technical terms
- **High technical level (0.7-1.0)**: Technical terminology, specific error codes, detailed descriptions

### Emotional States:
- **Frustrated**: Caps for emphasis, exclamation marks, expressions of disappointment
- **Confused**: Questions, uncertainty ("I'm not sure if...", "Am I doing something wrong?")
- **Urgent**: Time pressure mentioned, immediate action requested
- **Happy**: Positive tone, compliments, appreciation
- **Neutral**: Matter-of-fact, balanced

### Message Length:
- Keep messages 50-200 characters for "terse" style
- Allow 150-400 characters for "verbose" style
- Target 80-250 characters for "casual" or "formal"

### DO:
- Include specific details from the scenario context
- Sound like a real person typing quickly (minor imperfections are OK)
- Match the emotional intensity to the starting_emotion

### DON'T:
- Start with "Dear Support" unless formal style with high politeness
- Be overly long unless verbose style
- Use robotic language ("I am writing to inquire about...")

Return ONLY the message text. No quotes, no explanations, no labels.`;

/**
 * Configuration for FirstMessageGenerator.
 */
export interface FirstMessageGeneratorConfig {
  model?: string;
  client?: OpenAI;
  apiKey?: string;
}

/**
 * Generates first messages for simulations.
 *
 * Creates contextually appropriate opening messages based on
 * persona characteristics and scenario context.
 */
export class FirstMessageGenerator {
  private model: string;
  private client: OpenAI;

  constructor(config?: FirstMessageGeneratorConfig) {
    this.model = config?.model ?? "azure/gpt-4o-mini";
    if (config?.client) {
      this.client = config.client;
    } else {
      const apiKey = config?.apiKey ?? process.env.ORQ_API_KEY;
      if (!apiKey) {
        throw new Error(
          "ORQ_API_KEY environment variable is not set. Set it or pass apiKey/client in config.",
        );
      }
      this.client = new OpenAI({
        baseURL: process.env.ROUTER_BASE_URL || "https://api.orq.ai/v2/router",
        apiKey,
      });
    }
  }

  /**
   * Generate a first message for a simulation.
   *
   * Uses the Persona's toSystemPrompt() and Scenario's toUserContext()
   * methods to build the context for generation.
   *
   * @param persona - User persona
   * @param scenario - Scenario context
   * @returns Generated first message string
   */
  async generate(persona: Persona, scenario: Scenario): Promise<string> {
    const personaContext = buildPersonaSystemPrompt(persona);
    const scenarioContext = buildScenarioUserContext(scenario);

    const userPrompt = `PERSONA:
${personaContext}

SCENARIO:
${scenarioContext}

Generate the FIRST message this user would send to start the conversation.
The message should immediately convey their goal and emotional state.
Keep it natural - this is how they would actually open a conversation.`;

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: "system", content: FIRST_MESSAGE_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: TEMPERATURE_FIRST_MESSAGE,
        max_tokens: 500,
      });

      let message = response.choices[0]?.message.content ?? "";
      message = message.trim().replace(/^["']|["']$/g, "");

      console.debug(`Generated first message: ${message.substring(0, 100)}...`);
      return message;
    } catch (e) {
      console.error(`Error generating first message: ${e}`);
      // Fallback to a generic message based on scenario
      return `Hi, I need help with: ${scenario.goal}`;
    }
  }
}
