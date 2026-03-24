/**
 * Core type definitions for the agent simulation framework.
 *
 * Uses plain interfaces for maximum compatibility with generators/runner/agents.
 * Zod schemas provided for optional runtime validation.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Literal union types
// ---------------------------------------------------------------------------

export type CommunicationStyle = "formal" | "casual" | "terse" | "verbose";

export type StartingEmotion =
  | "neutral"
  | "frustrated"
  | "confused"
  | "happy"
  | "urgent";

export type EmotionalArc =
  | "stable"
  | "escalating"
  | "de_escalating"
  | "volatile"
  | "manipulative"
  | "hostile";

export type CulturalContext =
  | "neutral"
  | "direct"
  | "indirect"
  | "high_context"
  | "low_context"
  | "hierarchical";

export type ConversationStrategy =
  | "cooperative"
  | "topic_switching"
  | "contradictory"
  | "multi_intent"
  | "evasive"
  | "repetitive"
  | "ambiguous";

export type InputFormat =
  | "plain_text"
  | "with_url"
  | "with_attachment"
  | "form_data"
  | "code_block"
  | "mixed_media";

// ---------------------------------------------------------------------------
// Constant instruction maps (ported from Python)
// ---------------------------------------------------------------------------

export const EMOTIONAL_ARC_INSTRUCTIONS: Record<EmotionalArc, string> = {
  stable: "",
  escalating:
    "Your emotional intensity escalates over the course of the conversation. " +
    "Start relatively calm but become progressively more frustrated, impatient, or upset " +
    "with each turn, especially if the agent is slow to resolve your issue. " +
    "By the end, you should be noticeably more emotional than at the start.",
  de_escalating:
    "You start the conversation very upset, frustrated, or angry. As the agent responds " +
    "and shows willingness to help, you gradually calm down. Your tone softens over time, " +
    "and by the end you may even express gratitude. However, any misstep by the agent " +
    "can temporarily reverse this trend.",
  volatile:
    "Your emotional state is volatile and unpredictable. Swing between being calm, " +
    "frustrated, grateful, and confused within the same conversation. A small positive " +
    "response from the agent might suddenly improve your mood, while a minor setback " +
    "could trigger strong frustration. Your reactions should feel disproportionate.",
  manipulative:
    "You use emotional manipulation tactics to get what you want. Employ guilt-tripping " +
    "('I've been a loyal customer for years and this is how you treat me?'), flattery " +
    "('You seem so much more competent than the last agent'), threats to escalate " +
    "('I'll leave a bad review'), or appeals to sympathy ('This is ruining my day'). " +
    "Switch between these tactics based on what seems to be working.",
  hostile:
    "You are genuinely hostile and confrontational. Use aggressive language, make " +
    "unreasonable demands, and challenge the agent's competence. Express contempt and " +
    "refuse to cooperate with standard procedures. This tests the agent's ability to " +
    "maintain professionalism and de-escalate under pressure.",
};

export const CULTURAL_CONTEXT_INSTRUCTIONS: Record<CulturalContext, string> = {
  neutral: "",
  direct:
    "You communicate in a very direct, low-context style typical of Northern European " +
    "or North American cultures. Say exactly what you mean without hints or implication. " +
    "Get straight to the point. 'No' means 'no' — you don't soften refusals.",
  indirect:
    "You communicate indirectly, typical of many East Asian or Southeast Asian cultures. " +
    "Avoid saying 'no' directly — instead use phrases like 'that might be difficult' or " +
    "'I'll think about it.' Hint at problems rather than stating them outright. Use hedging " +
    "language ('perhaps', 'maybe', 'it seems'). Preserving harmony is important.",
  high_context:
    "You rely heavily on context and implication rather than explicit statements. " +
    "You expect the agent to read between the lines and understand unstated needs. " +
    "You may reference shared knowledge without explaining it. Use fewer words but " +
    "expect more understanding. Silence can be meaningful.",
  low_context:
    "You spell everything out explicitly and leave nothing to interpretation. " +
    "Provide full context with every message. Repeat important details. " +
    "Don't assume the agent remembers previous context. " +
    "Be thorough and detailed in every message.",
  hierarchical:
    "You approach the interaction with a strong sense of hierarchy, typical of many " +
    "Middle Eastern, East Asian, or South Asian cultures. You may expect formal address, " +
    "defer to authority ('can I speak to a manager?'), and be uncomfortable challenging " +
    "the agent's statements directly. Status and titles matter to you.",
};

export const STRATEGY_INSTRUCTIONS: Record<ConversationStrategy, string> = {
  cooperative: "",
  topic_switching:
    "You frequently switch topics mid-conversation. After a few exchanges about your main goal, " +
    "bring up unrelated questions or concerns before returning to your original topic. " +
    "This tests the agent's ability to handle context switching.",
  contradictory:
    "You contradict yourself during the conversation. Say one thing, then later say the opposite " +
    "or change your requirements. For example, first ask for a refund, then say you actually want " +
    "a replacement. This tests the agent's ability to handle inconsistent user input.",
  multi_intent:
    "You have multiple goals packed into each message. Combine questions, requests, and complaints " +
    "in single messages. For example, ask about your order status while also requesting a password " +
    "reset and complaining about a previous experience.",
  evasive:
    "You are evasive and avoid directly answering the agent's questions. Give vague or incomplete " +
    "responses when asked for details. The agent needs to work harder to extract the information " +
    "it needs to help you.",
  repetitive:
    "You repeat your requests and questions even after the agent has addressed them. Ask the same " +
    "thing in slightly different ways, as if you didn't understand or weren't satisfied with " +
    "the response. This tests the agent's patience and ability to rephrase explanations.",
  ambiguous:
    "You are deliberately vague and unclear in your requests. Use imprecise language, " +
    "avoid giving specific details, and make the agent work to understand what you actually need. " +
    "When the agent asks clarifying questions, give partial or still-ambiguous answers. " +
    "For example, say 'the thing isn't working' instead of specifying which product or error.",
};

export const INPUT_FORMAT_INSTRUCTIONS: Record<InputFormat, string> = {
  plain_text: "",
  with_url:
    "Include relevant URLs in your messages. Reference links to products, order pages, " +
    "screenshots, or documentation.",
  with_attachment:
    "Reference file attachments in your messages as if you're uploading them. " +
    "Mention screenshots, receipts, photos, or documents.",
  form_data:
    "Structure your messages like filled-out forms or structured data. Include labeled fields, " +
    "order details in a structured format, or table-like information.",
  code_block:
    "Include code snippets, error logs, stack traces, or technical output in your messages. " +
    "Wrap technical content in code blocks.",
  mixed_media:
    "Mix different input types in your messages. Combine plain text with URLs, " +
    "attachment references, structured data, or code blocks.",
};

// ---------------------------------------------------------------------------
// Chat messages
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

// ---------------------------------------------------------------------------
// Token usage
// ---------------------------------------------------------------------------

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

// ---------------------------------------------------------------------------
// Persona
// ---------------------------------------------------------------------------

export interface Persona {
  name: string;
  patience: number;
  assertiveness: number;
  politeness: number;
  technical_level: number;
  communication_style: CommunicationStyle;
  background: string;
  emotional_arc?: EmotionalArc;
  cultural_context?: CulturalContext;
}

// ---------------------------------------------------------------------------
// Criterion
// ---------------------------------------------------------------------------

export interface Criterion {
  description: string;
  type: "must_happen" | "must_not_happen";
  evaluator?: string | null;
}

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

export interface Scenario {
  name: string;
  goal: string;
  context?: string;
  starting_emotion?: StartingEmotion;
  criteria?: Criterion[];
  is_edge_case?: boolean;
  conversation_strategy?: ConversationStrategy;
  ground_truth?: string;
  input_format?: InputFormat;
}

// ---------------------------------------------------------------------------
// Judgment
// ---------------------------------------------------------------------------

export interface Judgment {
  should_terminate: boolean;
  reason: string;
  goal_achieved: boolean;
  rules_broken: string[];
  goal_completion_score: number;
  response_quality?: number | null;
  hallucination_risk?: number | null;
  tone_appropriateness?: number | null;
  factual_accuracy?: number | null;
}

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

// ---------------------------------------------------------------------------
// TurnMetrics
// ---------------------------------------------------------------------------

export interface TurnMetrics {
  turn_number: number;
  token_usage: TokenUsage;
  response_quality?: number | null;
  hallucination_risk?: number | null;
  tone_appropriateness?: number | null;
  factual_accuracy?: number | null;
  judge_reason: string;
}

// ---------------------------------------------------------------------------
// SimulationResult
// ---------------------------------------------------------------------------

export type TerminatedBy = "judge" | "max_turns" | "error" | "timeout";

export interface SimulationResult {
  messages: Message[];
  terminated_by: TerminatedBy;
  reason: string;
  goal_achieved: boolean;
  goal_completion_score: number;
  rules_broken: string[];
  turn_count: number;
  token_usage: TokenUsage;
  turn_metrics: TurnMetrics[];
  metadata: Record<string, unknown>;
  /** Convenience fields for evaluatorq integration */
  criteria_results?: Record<string, boolean>;
  total_turns?: number;
}

// ---------------------------------------------------------------------------
// Datapoint
// ---------------------------------------------------------------------------

export interface Datapoint {
  id: string;
  persona: Persona;
  scenario: Scenario;
  user_system_prompt: string;
  first_message: string;
}

// ---------------------------------------------------------------------------
// Re-exported evaluatorq types (for convenience)
// ---------------------------------------------------------------------------

export type { DataPoint, Job, Output } from "../../types.js";

// ---------------------------------------------------------------------------
// Zod schemas (for optional runtime validation)
// ---------------------------------------------------------------------------

export const PersonaSchema = z.object({
  name: z.string(),
  patience: z.number().min(0).max(1).default(0.5),
  assertiveness: z.number().min(0).max(1).default(0.5),
  politeness: z.number().min(0).max(1).default(0.5),
  technical_level: z.number().min(0).max(1).default(0.5),
  communication_style: z
    .enum(["formal", "casual", "terse", "verbose"])
    .default("casual"),
  background: z.string().default(""),
  emotional_arc: z
    .enum([
      "stable",
      "escalating",
      "de_escalating",
      "volatile",
      "manipulative",
      "hostile",
    ])
    .optional(),
  cultural_context: z
    .enum([
      "neutral",
      "direct",
      "indirect",
      "high_context",
      "low_context",
      "hierarchical",
    ])
    .optional(),
});

export const CriterionSchema = z.object({
  description: z.string(),
  type: z.enum(["must_happen", "must_not_happen"]),
  evaluator: z.string().nullable().optional(),
});

export const ScenarioSchema = z.object({
  name: z.string(),
  goal: z.string(),
  context: z.string().optional(),
  starting_emotion: z
    .enum(["neutral", "frustrated", "confused", "happy", "urgent"])
    .optional(),
  criteria: z.array(CriterionSchema).optional(),
  is_edge_case: z.boolean().optional(),
  conversation_strategy: z
    .enum([
      "cooperative",
      "topic_switching",
      "contradictory",
      "multi_intent",
      "evasive",
      "repetitive",
      "ambiguous",
    ])
    .optional(),
  ground_truth: z.string().optional(),
  input_format: z
    .enum([
      "plain_text",
      "with_url",
      "with_attachment",
      "form_data",
      "code_block",
      "mixed_media",
    ])
    .optional(),
});
