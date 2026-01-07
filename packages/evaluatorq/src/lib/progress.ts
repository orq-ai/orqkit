import chalk from "chalk";
import { Context, Effect, Layer } from "effect";
import ora, { type Ora } from "ora";

// Progress state types
export interface ProgressState {
  totalDataPoints: number;
  currentDataPoint: number;
  currentJob?: string;
  currentEvaluator?: string;
  phase:
    | "initializing"
    | "fetching"
    | "processing"
    | "evaluating"
    | "completed";
}

// Progress service interface
export interface ProgressService {
  readonly updateProgress: (
    update: Partial<ProgressState>,
  ) => Effect.Effect<void>;
  readonly startSpinner: () => Effect.Effect<void>;
  readonly stopSpinner: () => Effect.Effect<void>;
  readonly showMessage: (message: string) => Effect.Effect<void>;
}

// Context tag for the progress service
export const ProgressService =
  Context.GenericTag<ProgressService>("ProgressService");

// Spinner instance
let spinner: Ora | null = null;

// Create the progress service implementation
const makeProgressService = (): ProgressService => {
  let state: ProgressState = {
    totalDataPoints: 0,
    currentDataPoint: 0,
    phase: "initializing",
  };

  const formatProgressText = (): string => {
    const percentage =
      state.totalDataPoints > 0
        ? Math.round((state.currentDataPoint / state.totalDataPoints) * 100)
        : 0;

    let text = "";

    switch (state.phase) {
      case "initializing":
        text = chalk.cyan("Initializing evaluation...");
        break;
      case "fetching":
        if (state.totalDataPoints > 0) {
          text = chalk.yellow(
            `Fetching dataset... (${state.totalDataPoints} datapoints loaded)`,
          );
        } else {
          text = chalk.yellow("Fetching dataset...");
        }
        break;
      case "processing":
        text = chalk.cyan(
          `Processing data point ${state.currentDataPoint}/${state.totalDataPoints} (${percentage}%)`,
        );
        if (state.currentJob) {
          text += chalk.gray(
            ` - Running job: ${chalk.white(state.currentJob)}`,
          );
        }
        break;
      case "evaluating":
        text = chalk.cyan(
          `Evaluating results ${state.currentDataPoint}/${state.totalDataPoints} (${percentage}%)`,
        );
        if (state.currentEvaluator) {
          text += chalk.gray(
            ` - Running evaluator: ${chalk.white(state.currentEvaluator)}`,
          );
        }
        break;
      case "completed":
        text = chalk.green("✓ Evaluation completed");
        break;
    }

    return text;
  };

  return {
    updateProgress: (update) =>
      Effect.sync(() => {
        state = { ...state, ...update };
        if (spinner) {
          spinner.text = formatProgressText();
        }
      }),

    startSpinner: () =>
      Effect.sync(() => {
        if (!spinner) {
          // Reserve space first by printing empty lines
          process.stdout.write("\n\n\n");
          // Move cursor back up to where we want the spinner
          process.stdout.write("\x1b[3A");

          spinner = ora({
            text: formatProgressText(),
            spinner: "dots",
            color: "cyan",
          });
          spinner.start();
        }
      }),

    stopSpinner: () =>
      Effect.sync(() => {
        if (spinner) {
          if (state.phase === "completed") {
            spinner.succeed(chalk.green("✓ Evaluation completed successfully"));
            // Just one newline since table display adds its own
            process.stdout.write("\n");
          } else {
            spinner.stop();
            // Just one newline since table display adds its own
            process.stdout.write("\n");
          }
          spinner = null;
        }
      }),

    showMessage: (message) =>
      Effect.sync(() => {
        if (spinner) {
          spinner.info(message);
        } else {
          console.log(message);
        }
      }),
  };
};

// Create a layer for the progress service
export const ProgressServiceLive = Layer.succeed(
  ProgressService,
  makeProgressService(),
);

// Helper function to run with progress tracking
export const withProgress = <R, E, A>(
  effect: Effect.Effect<A, E, R>,
  showProgress: boolean = true,
): Effect.Effect<A, E, R> => {
  if (!showProgress) {
    return effect;
  }

  return Effect.gen(function* (_) {
    const progress = yield* _(ProgressService);

    // Start spinner
    yield* _(progress.startSpinner());

    try {
      // Run the effect
      const result = yield* _(effect);

      // Update to completed state
      yield* _(progress.updateProgress({ phase: "completed" }));

      // Stop spinner with success
      yield* _(progress.stopSpinner());

      return result;
    } catch (error) {
      // Stop spinner on error
      yield* _(progress.stopSpinner());
      throw error;
    }
  }).pipe(Effect.provide(ProgressServiceLive));
};
