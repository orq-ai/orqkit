export const JURY_JUDGE_RATES = {
  capturedAt: "2026-10-05T08:48:42.592121+00:00",
  catalogScope: "project",
  judges: {
    "anthropic/claude-opus-5-5": {
      inputRate: 4.0,
      outputRate: 20.0,
      defaultReasoningEffort: "medium",
    },
    "aws/eu.anthropic.claude-haiku-4-5-20251001-v1:0": {
      inputRate: 1.1,
      outputRate: 5.5,
      defaultReasoningEffort: null,
    },
    "azure/eu.gpt-5.6-luna": {
      inputRate: 0.2,
      outputRate: 1.2,
      defaultReasoningEffort: "medium",
    },
    "deepseek/deepseek-flash": {
      inputRate: 0.14,
      outputRate: 0.28,
      defaultReasoningEffort: "high",
    },
    "deepseek/deepseek-v4-pro": {
      inputRate: 0.435,
      outputRate: 0.87,
      defaultReasoningEffort: "high",
    },
    "google/eu.claude-sonnet-5": {
      inputRate: 2.2,
      outputRate: 11.0,
      defaultReasoningEffort: "high",
    },
    "google/eu.gemini-3.5-flash": {
      inputRate: 1.5,
      outputRate: 9.0,
      defaultReasoningEffort: "medium",
    },
    "google/gemini-3.6-flash": {
      inputRate: 1.5,
      outputRate: 7.5,
      defaultReasoningEffort: "medium",
    },
    "minimax/MiniMax-M2.7": {
      inputRate: 0.3,
      outputRate: 1.2,
      defaultReasoningEffort: null,
    },
    "openai/gpt-5.4-nano": {
      inputRate: 0.2,
      outputRate: 1.25,
      defaultReasoningEffort: "none",
    },
    "openai/gpt-5.6-sol": {
      inputRate: 4.0,
      outputRate: 20.0,
      defaultReasoningEffort: "medium",
    },
    "openai/gpt-5.6-terra": {
      inputRate: 2.0,
      outputRate: 12.0,
      defaultReasoningEffort: "medium",
    },
    "openai/gpt-6-luna": {
      inputRate: 0.1,
      outputRate: 0.5,
      defaultReasoningEffort: "medium",
    },
    "wafer/Kimi-K3": {
      inputRate: 3.0,
      outputRate: 12.75,
      defaultReasoningEffort: "none",
    },
    "zai/glm-5.2": {
      inputRate: 1.4,
      outputRate: 4.4,
      defaultReasoningEffort: "max",
    },
  },
} as const;
