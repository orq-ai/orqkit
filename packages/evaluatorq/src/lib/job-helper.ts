import type { DataPoint, Job, Output } from "./types.js";

/**
 * Helper function to create a named job that ensures the job name is preserved
 * even when errors occur during execution.
 *
 * @param name - The name of the job
 * @param fn - The job function that returns the output
 * @returns A Job function that always includes the job name
 *
 * @example
 * const myJob = job("myJobName", async (data) => {
 *   // Your job logic here
 *   return "output";
 * });
 */
export function job(
  name: string,
  fn: (data: DataPoint, row: number) => Promise<Output> | Output,
): Job {
  return async (data: DataPoint, row: number) => {
    try {
      const output = await fn(data, row);
      return {
        name,
        output,
      };
    } catch (error) {
      // Re-throw the error with the job name attached
      // The error will be caught by the evaluatorq framework
      // but the name will be preserved
      throw Object.assign(
        error instanceof Error ? error : new Error(String(error)),
        {
          jobName: name,
        },
      );
    }
  };
}
