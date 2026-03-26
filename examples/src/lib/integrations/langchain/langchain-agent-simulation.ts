/**
 * LangChain Agent Simulation Example
 *
 * Demonstrates how to use a LangChain agent as the target in
 * the evaluatorq simulation framework. The simulation generates
 * synthetic users that interact with your agent and evaluates
 * whether it achieves its goals.
 *
 * Prerequisites:
 *   - Set OPENAI_API_KEY environment variable
 *   - Set ORQ_API_KEY environment variable (for simulation LLM calls)
 *
 * Usage:
 *   OPENAI_API_KEY=your-key ORQ_API_KEY=your-key bun examples/src/lib/integrations/langchain/langchain-agent-simulation.ts
 */

import { tool } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

import { fromLangChainAgent } from "@orq-ai/evaluatorq/langchain";
import type { Persona, Scenario } from "@orq-ai/evaluatorq/simulation";
import { simulate } from "@orq-ai/evaluatorq/simulation";

// ============================================================
// 1. Define your agent (same as any LangChain agent)
// ============================================================

const model = new ChatOpenAI({ model: "gpt-4o" });

const lookupOrder = tool(
  async ({ orderId }) => {
    return {
      orderId,
      status: "shipped",
      estimatedDelivery: "2026-03-28",
      items: ["Blue Widget x2"],
    };
  },
  {
    name: "lookup_order",
    description: "Look up an order by order ID",
    schema: z.object({
      orderId: z.string().describe("The order ID to look up"),
    }),
  },
);

const initiateRefund = tool(
  async ({ orderId, reason }) => {
    return {
      orderId,
      refundId: `REF-${Date.now()}`,
      status: "processing",
      reason,
    };
  },
  {
    name: "initiate_refund",
    description: "Initiate a refund for an order",
    schema: z.object({
      orderId: z.string().describe("The order ID to refund"),
      reason: z.string().describe("Reason for the refund"),
    }),
  },
);

const supportAgent = createReactAgent({
  llm: model,
  tools: [lookupOrder, initiateRefund],
});

// ============================================================
// 2. Convert agent to simulation targetCallback
// ============================================================

const targetCallback = fromLangChainAgent(supportAgent, {
  instructions:
    "You are a helpful customer support agent. Be polite, empathetic, and always try to resolve the customer's issue. Use your tools to look up orders and process refunds when needed.",
});

// ============================================================
// 3. Define personas and scenarios for simulation
// ============================================================

const personas: Persona[] = [
  {
    name: "Impatient Tech Worker",
    patience: 0.2,
    assertiveness: 0.8,
    politeness: 0.4,
    technical_level: 0.9,
    communication_style: "terse",
    background:
      "Alex is a software engineer who ordered parts for a build. The delivery is late and they have a deadline. They expect quick, no-nonsense answers.",
  },
  {
    name: "Friendly Retiree",
    patience: 0.9,
    assertiveness: 0.3,
    politeness: 0.9,
    technical_level: 0.2,
    communication_style: "verbose",
    background:
      "Margaret is a retired teacher who ordered a gift for her grandchild. She is not in a rush but wants to make sure everything is okay. She appreciates detailed explanations.",
  },
];

const scenarios: Scenario[] = [
  {
    name: "Order Status Inquiry",
    goal: "Find out when the order will arrive",
    criteria: [
      {
        description: "Agent looks up the order using tools",
        type: "must_happen",
      },
      {
        description: "Agent provides an estimated delivery date",
        type: "must_happen",
      },
    ],
    context: "Customer placed order ORD-12345 three days ago.",
    ground_truth: "The order is shipped and arrives on 2026-03-28.",
  },
  {
    name: "Refund Request",
    goal: "Get a refund for a defective item",
    criteria: [
      {
        description: "Agent initiates the refund process",
        type: "must_happen",
      },
      {
        description: "Agent confirms the refund details",
        type: "must_happen",
      },
      {
        description: "Agent is rude or dismissive",
        type: "must_not_happen",
      },
    ],
    context:
      "Customer received order ORD-67890 but the widget was cracked on arrival.",
    ground_truth:
      "The agent should process a refund for order ORD-67890 due to a defective item.",
  },
];

// ============================================================
// 4. Run the simulation
// ============================================================

async function run() {
  console.log("\nLangChain Agent Simulation\n");
  console.log("Running simulations with 2 personas x 2 scenarios...\n");

  const results = await simulate({
    evaluationName: "langchain-agent-simulation",
    targetCallback,
    personas,
    scenarios,
    maxTurns: 5,
    evaluators: ["goal_achieved", "criteria_met"],
  });

  console.log(`\nCompleted ${results.length} simulations:\n`);

  for (const result of results) {
    const meta = result.metadata as Record<string, unknown>;
    console.log(`  ${meta.persona} x ${meta.scenario}`);
    console.log(`    Turns: ${result.turn_count}`);
    console.log(`    Goal achieved: ${result.goal_achieved}`);
    console.log(`    Terminated by: ${result.terminated_by}`);
    if (result.criteria_results) {
      for (const [criterion, passed] of Object.entries(
        result.criteria_results,
      )) {
        console.log(`    ${passed ? "PASS" : "FAIL"}: ${criterion}`);
      }
    }
    console.log();
  }

  return results;
}

run().catch(console.error);
