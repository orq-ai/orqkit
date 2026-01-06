import type { Evaluator } from "@orq-ai/evaluatorq";

/**
 * Configuration options for the string contains evaluator
 */
export interface StringContainsConfig {
	/**
	 * Whether the comparison should be case-insensitive
	 * @default true
	 */
	caseInsensitive?: boolean;
	/**
	 * Optional name for the evaluator
	 * @default "string-contains"
	 */
	name?: string;
}

/**
 * Creates an evaluator that checks if the output contains the expected output.
 * Uses the data.expectedOutput from the dataset to compare against.
 *
 * @example
 * ```typescript
 * const evaluator = stringContainsEvaluator();
 *
 * // With case-sensitive matching
 * const strictEvaluator = stringContainsEvaluator({ caseInsensitive: false });
 * ```
 */
export function stringContainsEvaluator(
	config: StringContainsConfig = {},
): Evaluator {
	const { caseInsensitive = true, name = "string-contains" } = config;

	return {
		name,
		scorer: async ({ data, output }) => {
			const expected = String(data.expectedOutput ?? "");
			const actual = String(output ?? "");

			if (!expected) {
				return {
					value: 0,
					pass: false,
					explanation: "No expected output defined",
				};
			}

			const expectedNormalized = caseInsensitive
				? expected.toLowerCase()
				: expected;
			const actualNormalized = caseInsensitive ? actual.toLowerCase() : actual;

			const contains = actualNormalized.includes(expectedNormalized);

			return {
				value: contains ? 1.0 : 0.0,
				pass: contains,
				explanation: contains
					? `Output contains "${expected}"`
					: `Expected "${expected}" not found in: "${actual.substring(0, 100)}${actual.length > 100 ? "..." : ""}"`,
			};
		},
	};
}
