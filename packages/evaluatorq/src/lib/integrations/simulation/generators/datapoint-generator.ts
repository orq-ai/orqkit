/**
 * Datapoint generator for creating test datasets.
 *
 * Combines personas and scenarios into complete datapoints with first messages.
 */

import { applyRandomPerturbation } from "../quality/message-perturbation.js";
import type { Datapoint, Persona, Scenario } from "../types.js";
import { generateDatapoint } from "../utils/prompt-builders.js";
import { FirstMessageGenerator } from "./first-message-generator.js";
import { PersonaGenerator } from "./persona-generator.js";
import { ScenarioGenerator } from "./scenario-generator.js";

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
  model?: string;
  rateLimitDelay?: number;
  maxConcurrentCalls?: number;
}

/**
 * Generates complete datapoints for simulation.
 *
 * Orchestrates persona, scenario, and first message generation
 * to produce ready-to-use test datapoints.
 */
export class DatapointGenerator {
  private model: string;
  private rateLimitDelay: number;
  private semaphore: Semaphore;
  private personaGenerator: PersonaGenerator;
  private scenarioGenerator: ScenarioGenerator;
  private firstMessageGenerator: FirstMessageGenerator;

  constructor(config?: DatapointGeneratorConfig) {
    this.model = config?.model ?? "azure/gpt-4o-mini";
    this.rateLimitDelay = config?.rateLimitDelay ?? DEFAULT_RATE_LIMIT_DELAY;
    this.semaphore = new Semaphore(
      config?.maxConcurrentCalls ?? DEFAULT_MAX_CONCURRENT_CALLS,
    );
    this.personaGenerator = new PersonaGenerator({ model: this.model });
    this.scenarioGenerator = new ScenarioGenerator({ model: this.model });
    this.firstMessageGenerator = new FirstMessageGenerator({
      model: this.model,
    });
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
      edgeCasePercentage = 0.2,
      perturbationRate = 0.0,
      includeBoundary = false,
      numBoundary = 5,
      includeSecurity = false,
      numSecurity = 5,
      securitySeedExamples,
      securityCategories,
    } = params;

    console.log(
      `Generating ${numPersonas} personas and ${numScenarios} scenarios...`,
    );

    // Build named tasks for parallel generation
    const namedTasks: Record<string, Promise<Persona[] | Scenario[]>> = {
      personas: this.personaGenerator.generate({
        agentDescription,
        context,
        numPersonas,
        edgeCasePercentage,
      }),
      scenarios: this.scenarioGenerator.generate({
        agentDescription,
        context,
        numScenarios,
        edgeCasePercentage,
      }),
    };

    if (includeBoundary) {
      console.log(`Including ${numBoundary} boundary scenarios`);
      namedTasks.boundary = this.scenarioGenerator.generateBoundaryScenarios({
        agentDescription,
        numScenarios: numBoundary,
      });
    }

    if (includeSecurity) {
      console.log(`Including ${numSecurity} security scenarios`);
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

    let personas = results.personas as Persona[];
    let scenarios = results.scenarios as Scenario[];

    // Merge additional scenario types
    if (results.boundary) {
      const boundary = results.boundary as Scenario[];
      console.log(`Generated ${boundary.length} boundary scenarios`);
      scenarios = [...scenarios, ...boundary];
    }
    if (results.security) {
      const security = results.security as Scenario[];
      console.log(`Generated ${security.length} security scenarios`);
      scenarios = [...scenarios, ...security];
    }

    if (personas.length === 0) {
      console.warn("No personas generated, using defaults");
      personas = [
        {
          name: "Default User",
          patience: 0.5,
          assertiveness: 0.5,
          politeness: 0.5,
          technical_level: 0.5,
          communication_style: "casual",
          background: "",
        },
      ];
    }

    if (scenarios.length === 0) {
      console.warn("No scenarios generated, using defaults");
      scenarios = [
        {
          name: "Default Scenario",
          goal: "Get help",
          context: "User needs general assistance",
          starting_emotion: "neutral" as const,
          criteria: [],
        },
      ];
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

    console.log(
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
    const tasks = combinations.map(([p, s]) => generateSingle(p, s));
    const datapoints = await Promise.all(tasks);

    console.log(`Generated ${datapoints.length} datapoints`);
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
        console.debug(`Applied ${pType} perturbation to: ${dp.scenario.name}`);
        // Create a new datapoint with the perturbed message (immutable update)
        return {
          ...dp,
          first_message: perturbedMsg,
        };
      }
      return dp;
    });

    if (perturbedCount > 0) {
      console.log(
        `Applied perturbations to ${perturbedCount}/${datapoints.length} first messages`,
      );
    }

    return result;
  }
}
