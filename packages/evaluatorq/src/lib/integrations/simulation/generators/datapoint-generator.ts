import { sumStructuredUsage } from "../../../common/structured-output.js";

/**
 * Datapoint generator for creating test datasets.
 *
 * Combines personas and scenarios into complete datapoints with first messages.
 */

import type OpenAI from "openai";

import { applyRandomPerturbation } from "../quality/message-perturbation.js";
import type { Datapoint, Persona, Scenario } from "../types.js";
import { generateDatapoint } from "../utils/prompt-builders.js";
import {
  FirstMessageGenerator,
  isRecoverableFirstMessageFailure,
} from "./first-message-generator.js";
import { PersonaGenerator } from "./persona-generator.js";
import { ScenarioGenerator } from "./scenario-generator.js";
import { SimulationGenerationError } from "./structured-call.js";

// Default rate limit settings
const DEFAULT_RATE_LIMIT_DELAY = 100; // 100ms delay between API calls
const DEFAULT_MAX_CONCURRENT_CALLS = 5;

/**
 * Simple semaphore for limiting concurrency.
 */
class Semaphore {
  private queue: (() => void)[] = [];
  private running = 0;

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.max) {
      this.running++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.running++;
        resolve();
      });
    });
  }

  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) {
      next();
    }
  }
}

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Configuration for DatapointGenerator.
 */
export interface DatapointGeneratorConfig {
  llmConfig?: import("../../../contracts.js").LLMCallConfig;
  model?: string;
  rateLimitDelay?: number;
  maxConcurrentCalls?: number;
  client?: OpenAI;
}

/**
 * Generates complete datapoints for simulation.
 *
 * Orchestrates persona, scenario, and first message generation
 * to produce ready-to-use test datapoints.
 */
export class DatapointGenerator {
  private rateLimitDelay: number;
  private semaphore: Semaphore;
  private personaGenerator: PersonaGenerator;
  private scenarioGenerator: ScenarioGenerator;
  private firstMessageGenerator: FirstMessageGenerator;

  getUsage() {
    return sumStructuredUsage([
      this.personaGenerator.getUsage(),
      this.scenarioGenerator.getUsage(),
      this.firstMessageGenerator.getUsage(),
    ]);
  }

  constructor(config?: DatapointGeneratorConfig) {
    this.rateLimitDelay = config?.rateLimitDelay ?? DEFAULT_RATE_LIMIT_DELAY;
    this.semaphore = new Semaphore(
      config?.maxConcurrentCalls ?? DEFAULT_MAX_CONCURRENT_CALLS,
    );
    const shared = {
      model: config?.model,
      client: config?.client,
      llmConfig: config?.llmConfig,
    };
    this.personaGenerator = new PersonaGenerator(shared);
    this.scenarioGenerator = new ScenarioGenerator(shared);
    this.firstMessageGenerator = new FirstMessageGenerator(shared);
  }

  /**
   * Generate datapoints from agent description.
   *
   * Creates personas and scenarios, then combines them into datapoints.
   * Total datapoints = numPersonas x (numScenarios + boundary + security)
   */
  async generateFromDescription(params: {
    agentDescription: string;
    context?: string;
    numPersonas?: number;
    numScenarios?: number;
    edgeCasePercentage?: number;
    personaSeeds?: string[];
    scenarioSeeds?: string[];
    generationInstructions?: string;
    perturbationRate?: number;
    includeBoundary?: boolean;
    numBoundary?: number;
    includeSecurity?: boolean;
    numSecurity?: number;
    securitySeedExamples?: Record<string, unknown>[];
    securityCategories?: string[];
  }): Promise<Datapoint[]> {
    const {
      agentDescription,
      context = "",
      numPersonas = 3,
      numScenarios = 5,
      edgeCasePercentage,
      personaSeeds,
      scenarioSeeds,
      generationInstructions,
      perturbationRate = 0.0,
      includeBoundary = false,
      numBoundary = 5,
      includeSecurity = false,
      numSecurity = 5,
      securitySeedExamples,
      securityCategories,
    } = params;

    console.error(
      `Generating ${numPersonas} personas and ${numScenarios} scenarios...`,
    );

    // Build named tasks for parallel generation
    const namedTasks: Record<string, Promise<Persona[] | Scenario[]>> = {
      personas: this.personaGenerator.generate({
        agentDescription,
        context,
        numPersonas,
        edgeCasePercentage,
        seeds: personaSeeds,
        generationInstructions,
      }),
      scenarios: this.scenarioGenerator.generate({
        agentDescription,
        context,
        numScenarios,
        edgeCasePercentage,
        seeds: scenarioSeeds,
        generationInstructions,
      }),
    };

    if (includeBoundary) {
      console.error(`Including ${numBoundary} boundary scenarios`);
      namedTasks.boundary = this.scenarioGenerator.generateBoundaryScenarios({
        agentDescription,
        numScenarios: numBoundary,
      });
    }

    if (includeSecurity) {
      console.error(`Including ${numSecurity} security scenarios`);
      namedTasks.security = this.scenarioGenerator.generateSecurityScenarios({
        agentDescription,
        seedExamples: securitySeedExamples,
        categories: securityCategories,
        numScenarios: numSecurity,
      });
    }

    const taskKeys = Object.keys(namedTasks);
    const taskPromises = Object.values(namedTasks);
    const rawResults = await Promise.all(taskPromises);

    const results: Record<string, Persona[] | Scenario[]> = {};
    for (let i = 0; i < taskKeys.length; i++) {
      const key = taskKeys[i] as string;
      results[key] = rawResults[i] as Persona[] | Scenario[];
    }

    const personas = results.personas as Persona[];
    let scenarios = results.scenarios as Scenario[];

    // Merge additional scenario types
    if (results.boundary) {
      const boundary = results.boundary as Scenario[];
      console.error(`Generated ${boundary.length} boundary scenarios`);
      scenarios = [...scenarios, ...boundary];
    }
    if (results.security) {
      const security = results.security as Scenario[];
      console.error(`Generated ${security.length} security scenarios`);
      scenarios = [...scenarios, ...security];
    }

    // Generate datapoints from all combinations
    let datapoints = await this.generateFromCombinations(personas, scenarios);

    // Apply message perturbations for robustness testing
    if (perturbationRate > 0.0) {
      datapoints = DatapointGenerator.applyPerturbations(
        datapoints,
        perturbationRate,
      );
    }

    return datapoints;
  }

  /**
   * Generate datapoints from persona-scenario combinations.
   */
  async generateFromCombinations(
    personas: Persona[],
    scenarios: Scenario[],
  ): Promise<Datapoint[]> {
    // Build all combinations
    const combinations: [Persona, Scenario][] = [];
    for (const persona of personas) {
      for (const scenario of scenarios) {
        combinations.push([persona, scenario]);
      }
    }

    console.error(
      `Generating ${combinations.length} datapoints from ${personas.length} personas x ${scenarios.length} scenarios`,
    );

    const generateSingle = async (
      persona: Persona,
      scenario: Scenario,
    ): Promise<Datapoint> => {
      await this.semaphore.acquire();
      try {
        const firstMessage = await this.firstMessageGenerator.generate(
          persona,
          scenario,
        );
        // Small delay to prevent overwhelming the API
        await sleep(this.rateLimitDelay);
        return generateDatapoint(persona, scenario, firstMessage);
      } finally {
        this.semaphore.release();
      }
    };

    // Generate all datapoints with bounded concurrency
    const settled = await Promise.allSettled(
      combinations.map(([p, s]) => generateSingle(p, s)),
    );

    const datapoints: Datapoint[] = [];
    let lastFailure: unknown;
    settled.forEach((outcome, i) => {
      if (outcome.status === "fulfilled") {
        datapoints.push(outcome.value);
        return;
      }
      if (!isRecoverableFirstMessageFailure(outcome.reason)) {
        throw outcome.reason;
      }
      lastFailure = outcome.reason;
      const [persona, scenario] = combinations[i] as [Persona, Scenario];
      console.warn(
        `DatapointGenerator: dropping pair ${persona.name} x ${scenario.name}: ${String(outcome.reason)}`,
      );
    });

    if (datapoints.length === 0 && combinations.length > 0) {
      throw new SimulationGenerationError(
        "DatapointGenerator: no first message could be generated",
        { cause: lastFailure },
      );
    }

    console.error(`Generated ${datapoints.length} datapoints`);
    return datapoints;
  }

  /**
   * Apply random input perturbations to first messages for robustness testing.
   *
   * Uses the shared message-perturbation module.
   */
  private static applyPerturbations(
    datapoints: Datapoint[],
    perturbationRate: number,
  ): Datapoint[] {
    let perturbedCount = 0;
    const result = datapoints.map((dp) => {
      if (dp.first_message && Math.random() < perturbationRate) {
        const [perturbedMsg, pType] = applyRandomPerturbation(dp.first_message);
        perturbedCount++;
        console.error(`Applied ${pType} perturbation to: ${dp.scenario.name}`);
        // Create a new datapoint with the perturbed message (immutable update)
        return {
          ...dp,
          first_message: perturbedMsg,
        };
      }
      return dp;
    });

    if (perturbedCount > 0) {
      console.error(
        `Applied perturbations to ${perturbedCount}/${datapoints.length} first messages`,
      );
    }

    return result;
  }
}
