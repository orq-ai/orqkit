/**
 * Simulation test with a real orq agent to verify target_call LLM spans.
 *
 * Usage:
 *   ORQ_API_KEY=<key> bun test-simulation-tracing.ts
 */

import { simulate } from "@orq-ai/evaluatorq/simulation";
import type { Persona, Scenario } from "@orq-ai/evaluatorq/simulation";

const personas: Persona[] = [
	{
		name: "Junior Developer",
		patience: 0.6,
		assertiveness: 0.5,
		politeness: 0.7,
		technical_level: 0.2,
		communication_style: "casual",
		background:
			"Sam is a very junior dev, only 2 weeks into Python. They don't understand functions well and need things explained simply. They will ask follow-up questions about every answer.",
	},
];

const scenarios: Scenario[] = [
	{
		name: "Python Debugging Help",
		goal: "Get help fixing a Python TypeError and understanding why it happened",
		criteria: [
			{
				description: "Agent identifies the root cause of the error",
				type: "must_happen",
			},
			{
				description: "Agent provides a working code fix",
				type: "must_happen",
			},
		],
		context:
			'User is getting "TypeError: cannot unpack non-sequence NoneType" when calling a function that returns None. The user does not share code upfront — the agent must ask for it.',
		ground_truth:
			"The function is returning None instead of a tuple. Add a None check or fix the return value.",
	},
];

async function main() {
	console.log(
		"Running simulation with code-specialist-agent (1 persona x 1 scenario, 2 turns)...\n",
	);

	const results = await simulate({
		evaluationName: "tracing-test-real-agent",
		agentKey: "code-specialist-agent",
		personas,
		scenarios,
		maxTurns: 2,
		evaluators: ["goal_achieved", "criteria_met"],
	});

	console.log(`\nCompleted ${results.length} simulation(s):`);
	for (const r of results) {
		const meta = r.metadata as Record<string, unknown>;
		console.log(`  ${meta.persona} x ${meta.scenario}`);
		console.log(`  Turns: ${r.turn_count}, Goal: ${r.goal_achieved}`);
	}

	console.log("\nDone — check the orq dashboard for the trace.");
}

main().catch(console.error);
