/**
 * Persona generator using LLM.
 *
 * Generates user personas from agent descriptions and optional context.
 */

import OpenAI from "openai";

import type { CommunicationStyle, Persona } from "../types.js";
import { extractJsonFromResponse } from "../utils/extract-json.js";
import { delimit } from "../utils/sanitize.js";

// Temperature settings for different generation modes
const TEMPERATURE_CREATIVE = 0.8;
const TEMPERATURE_BALANCED = 0.7;

const VALID_STYLES = new Set<string>(["formal", "casual", "terse", "verbose"]);

/** Clamp a number to [0, 1]. */
function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

const PERSONA_GENERATOR_PROMPT = `You are an expert persona designer for AI agent testing. Create realistic, memorable user personas that feel like real people, not stereotypes.

## Persona Structure
Each persona must include:
- **name**: A vivid, specific descriptor (e.g., "Anxious First-Time Buyer", "Retired Engineer Seeking Help")
- **patience**: 0-1 (0=interrupts constantly, 1=waits indefinitely)
- **assertiveness**: 0-1 (0=accepts anything, 1=demands specific outcomes)
- **politeness**: 0-1 (0=rude/demanding, 1=overly polite)
- **technical_level**: 0-1 (0=never used a computer, 1=software developer)
- **communication_style**: "formal", "casual", "terse", or "verbose"
- **background**: DETAILED context (2-3 sentences) explaining WHO they are, WHY they're contacting support, and WHAT their emotional state is

## Quality Guidelines

### DO create personas that are:
- **Realistic**: Based on actual customer archetypes you'd encounter
- **Coherent**: Traits that logically fit together (e.g., high technical_level + formal style for an engineer)
- **Specific**: Unique situations with concrete details (names, specific products, timeframes)
- **Emotionally grounded**: Clear emotional context that explains their behavior

### DON'T create personas that are:
- Generic (e.g., "Customer with a problem")
- Contradictory (e.g., patience=0.1 but described as "patient and understanding")
- Unrealistic trait combinations (e.g., technical_level=0.9 + communication_style="terse" for a "confused elderly person")
- All similar - vary trait values across personas, including some with low values and some with high values

## Example HIGH-QUALITY Persona:
{
  "name": "Overwhelmed Working Parent",
  "patience": 0.3,
  "assertiveness": 0.6,
  "politeness": 0.7,
  "technical_level": 0.4,
  "communication_style": "terse",
  "background": "Sarah is a working mom with two kids under 5. She ordered a birthday gift (a tablet) for her daughter 2 weeks ago but it hasn't arrived. The party is in 3 days. She's stressed, multitasking while on hold, and needs quick answers without lengthy explanations."
}

## Example LOW-QUALITY Persona (AVOID):
{
  "name": "Angry Customer",
  "patience": 0.1,
  "assertiveness": 0.9,
  "politeness": 0.2,
  "technical_level": 0.5,
  "communication_style": "casual",
  "background": "A customer who is angry about something"  // TOO VAGUE!
}

Return a JSON array of persona objects.`;

/**
 * Configuration for PersonaGenerator.
 */
export interface PersonaGeneratorConfig {
  model?: string;
  client?: OpenAI;
  apiKey?: string;
}

/**
 * Generates personas from agent descriptions.
 *
 * Uses an LLM to create diverse, realistic user personas
 * based on the agent's purpose and context.
 */
export class PersonaGenerator {
  private model: string;
  private client: OpenAI;

  constructor(config?: PersonaGeneratorConfig) {
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
   * Parse LLM response content into Persona objects.
   */
  private static parsePersonas(content: string): Persona[] {
    const extracted = extractJsonFromResponse(content);
    let personaDicts: unknown[];
    try {
      personaDicts = JSON.parse(extracted) as unknown[];
    } catch {
      console.warn("Failed to parse personas JSON response");
      return [];
    }

    const personas: Persona[] = [];
    for (const pDict of personaDicts) {
      try {
        const p = pDict as Record<string, unknown>;
        const rawStyle = String(p.communication_style ?? "casual");
        personas.push({
          name: String(p.name ?? ""),
          patience: clamp01(Number(p.patience ?? 0.5)),
          assertiveness: clamp01(Number(p.assertiveness ?? 0.5)),
          politeness: clamp01(Number(p.politeness ?? 0.5)),
          technical_level: clamp01(Number(p.technical_level ?? 0.5)),
          communication_style: VALID_STYLES.has(rawStyle)
            ? (rawStyle as CommunicationStyle)
            : "casual",
          background: String(p.background ?? ""),
        });
      } catch (e) {
        console.warn(`Failed to parse persona: ${e}`);
      }
    }
    return personas;
  }

  /**
   * Generate personas for agent testing.
   */
  async generate(params: {
    agentDescription: string;
    context?: string;
    numPersonas?: number;
    edgeCasePercentage?: number;
  }): Promise<Persona[]> {
    const {
      agentDescription,
      context = "",
      numPersonas = 5,
      edgeCasePercentage = 0.2,
    } = params;

    const numEdgeCases = Math.floor(numPersonas * edgeCasePercentage);

    const userPrompt = `Agent Description: ${delimit(agentDescription)}

Additional Context: ${delimit(context || "None provided")}

Generate ${numPersonas} diverse personas for testing this agent.
- Include ${numEdgeCases} edge case/challenging personas
- Ensure variety in patience, assertiveness, and technical levels
- Create realistic backgrounds relevant to the agent's domain

Return ONLY a JSON array, no other text.`;

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: PERSONA_GENERATOR_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: TEMPERATURE_CREATIVE,
      max_tokens: 4000,
    });

    const content = response.choices[0]?.message.content ?? "[]";
    const personas = PersonaGenerator.parsePersonas(content);

    if (personas.length < numPersonas) {
      console.warn(
        `PersonaGenerator: requested ${numPersonas} personas but only ${personas.length} were successfully parsed`,
      );
    }
    return personas;
  }

  /**
   * Generate personas with guaranteed trait coverage.
   *
   * Ensures all communication styles and trait ranges are represented,
   * including extreme values that LLMs tend to avoid.
   */
  async generateWithCoverage(params: {
    agentDescription: string;
    context?: string;
    numPersonas?: number;
    edgeCasePercentage?: number;
  }): Promise<Persona[]> {
    const {
      agentDescription,
      context = "",
      numPersonas = 8,
      edgeCasePercentage = 0.2,
    } = params;

    const styles: CommunicationStyle[] = [
      "formal",
      "casual",
      "terse",
      "verbose",
    ];

    // Explicit trait combinations covering the FULL range (0.0-1.0)
    const traitTargets = [
      {
        patience: 0.1,
        assertiveness: 0.1,
        politeness: 0.1,
        technical_level: 0.1,
      },
      {
        patience: 0.9,
        assertiveness: 0.1,
        politeness: 0.9,
        technical_level: 0.9,
      },
      {
        patience: 0.1,
        assertiveness: 0.9,
        politeness: 0.1,
        technical_level: 0.5,
      },
      {
        patience: 0.5,
        assertiveness: 0.9,
        politeness: 0.9,
        technical_level: 0.1,
      },
      {
        patience: 0.5,
        assertiveness: 0.5,
        politeness: 0.5,
        technical_level: 0.5,
      },
      {
        patience: 0.3,
        assertiveness: 0.7,
        politeness: 0.6,
        technical_level: 0.3,
      },
      {
        patience: 0.7,
        assertiveness: 0.3,
        politeness: 0.8,
        technical_level: 0.7,
      },
      {
        patience: 0.2,
        assertiveness: 0.8,
        politeness: 0.3,
        technical_level: 0.8,
      },
    ];

    const numEdgeCases = Math.floor(numPersonas * edgeCasePercentage);

    const coverageInstructions = Array.from(
      { length: Math.min(numPersonas, 8) },
      (_, i) => {
        const target = traitTargets[
          i % traitTargets.length
        ] as (typeof traitTargets)[number];
        return (
          `- Persona ${i + 1}: communication_style='${styles[i % styles.length]}', ` +
          `patience=${target.patience.toFixed(1)}, ` +
          `assertiveness=${target.assertiveness.toFixed(1)}, ` +
          `politeness=${target.politeness.toFixed(1)}, ` +
          `technical_level=${target.technical_level.toFixed(1)}`
        );
      },
    ).join("\n");

    const userPrompt = `Agent Description: ${delimit(agentDescription)}

Additional Context: ${delimit(context || "None provided")}

Generate ${numPersonas} personas with EXACT trait values as specified below.
CRITICAL: Use the EXACT numeric values provided - do NOT adjust them to be more "balanced".

${coverageInstructions}

IMPORTANT:
- Use the EXACT trait values shown above (e.g., if it says politeness=0.1, use 0.1, not 0.3 or 0.5)
- Low values (0.1-0.2) represent EXTREME traits - these are intentional, not mistakes
- Include ${numEdgeCases} edge case/challenging personas
- Ensure traits span the full 0-1 range across all personas
- Create realistic backgrounds relevant to the agent's domain

Return ONLY a JSON array, no other text.`;

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: PERSONA_GENERATOR_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: TEMPERATURE_BALANCED,
      max_tokens: 4000,
    });

    const content = response.choices[0]?.message.content ?? "[]";
    let personas = PersonaGenerator.parsePersonas(content);

    // Validate coverage and fill gaps if needed
    personas = this.ensureStyleCoverage(personas, styles);
    this.logTraitCoverageGaps(personas);

    // Trim to requested count (coverage adjustments may have kept extras)
    if (personas.length > numPersonas) {
      personas = personas.slice(0, numPersonas);
    }

    if (personas.length < numPersonas) {
      console.warn(
        `PersonaGenerator: requested ${numPersonas} personas (with coverage) but only ${personas.length} were successfully parsed`,
      );
    }
    return personas;
  }

  /**
   * Ensure all communication styles are covered.
   */
  private ensureStyleCoverage(
    personas: Persona[],
    requiredStyles: CommunicationStyle[],
  ): Persona[] {
    const existingStyles = new Set(personas.map((p) => p.communication_style));
    const missingStyles = requiredStyles.filter((s) => !existingStyles.has(s));

    if (missingStyles.length > 0 && personas.length > 0) {
      for (let i = 0; i < missingStyles.length; i++) {
        const style = missingStyles[i] as CommunicationStyle;
        if (i < personas.length) {
          const p = personas[i] as Persona;
          // Create a new persona with the adjusted style (immutable update)
          personas[i] = {
            ...p,
            communication_style: style,
          };
          console.debug(
            `Adjusted persona '${p.name}' to style '${style}' for coverage`,
          );
        }
      }
    }

    return personas;
  }

  /**
   * Log warnings about missing trait coverage without modifying personas.
   */
  private logTraitCoverageGaps(personas: Persona[]): void {
    if (personas.length === 0) return;

    const hasLow = (values: number[]): boolean => values.some((v) => v <= 0.2);
    const hasHigh = (values: number[]): boolean => values.some((v) => v >= 0.8);

    const patienceVals = personas.map((p) => p.patience);
    const assertiveVals = personas.map((p) => p.assertiveness);
    const politeVals = personas.map((p) => p.politeness);
    const techVals = personas.map((p) => p.technical_level);

    const gaps: string[] = [];
    if (!hasLow(patienceVals)) gaps.push("low patience (<0.2)");
    if (!hasHigh(patienceVals)) gaps.push("high patience (>0.8)");
    if (!hasLow(assertiveVals)) gaps.push("low assertiveness (<0.2)");
    if (!hasHigh(assertiveVals)) gaps.push("high assertiveness (>0.8)");
    if (!hasLow(politeVals)) gaps.push("low politeness (<0.2)");
    if (!hasHigh(politeVals)) gaps.push("high politeness (>0.8)");
    if (!hasLow(techVals)) gaps.push("low technical_level (<0.2)");
    if (!hasHigh(techVals)) gaps.push("high technical_level (>0.8)");

    if (gaps.length > 0) {
      console.debug(`Trait coverage gaps: ${gaps.join(", ")}`);
    }
  }
}
