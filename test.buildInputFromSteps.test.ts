import { describe, expect, it } from "bun:test";

// ============================================================
// Mock data based on actual AI SDK ToolLoopAgent step structure
// ============================================================

const mockStepsWithToolCalls = [
  {
    content: [
      {
        type: "tool-call",
        toolCallId: "call_abc123",
        toolName: "weather",
        input: {
          location: "San Francisco",
        },
      },
      {
        type: "tool-result",
        toolCallId: "call_abc123",
        toolName: "weather",
        input: {
          location: "San Francisco",
        },
        output: {
          location: "San Francisco",
          temperature: 72,
        },
      },
    ],
    finishReason: "tool-calls",
  },
  {
    content: [
      {
        type: "tool-call",
        toolCallId: "call_def456",
        toolName: "convertFahrenheitToCelsius",
        input: {
          temperature: 72,
        },
      },
      {
        type: "tool-result",
        toolCallId: "call_def456",
        toolName: "convertFahrenheitToCelsius",
        input: {
          temperature: 72,
        },
        output: {
          celsius: 22,
        },
      },
    ],
    finishReason: "tool-calls",
  },
  {
    content: [
      {
        type: "text",
        text: "The weather in San Francisco is 22°C.",
      },
    ],
    finishReason: "stop",
  },
];

// ============================================================
// Simplified buildInputFromSteps for testing
// ============================================================

interface StepData {
  content?: Array<{
    type: string;
    toolCallId?: string;
    toolName?: string;
    input?: unknown;
    output?: unknown;
  }>;
}

let idCounter = 0;
function generateItemId(prefix: string): string {
  return `${prefix}_test_${idCounter++}`;
}

function buildInputFromSteps(
  steps: unknown[],
  prompt: string | undefined
): unknown[] {
  const input: unknown[] = [];

  // Add the initial user message
  if (prompt) {
    input.push({
      role: "user",
      content: [
        {
          type: "input_text",
          text: prompt,
        },
      ],
    });
  }

  // Collect all function calls and outputs from steps
  for (const step of steps) {
    const stepData = step as StepData;

    // Extract from content array (ToolLoopAgent format)
    if (stepData.content && stepData.content.length > 0) {
      for (const item of stepData.content) {
        if (item.type === "tool-call" && item.toolCallId && item.toolName) {
          input.push({
            type: "function_call",
            id: generateItemId("fc"),
            call_id: item.toolCallId,
            name: item.toolName,
            arguments:
              typeof item.input === "string"
                ? item.input
                : JSON.stringify(item.input),
          });
        }
        if (item.type === "tool-result" && item.toolCallId) {
          input.push({
            type: "function_call_output",
            call_id: item.toolCallId,
            output:
              typeof item.output === "string"
                ? item.output
                : JSON.stringify(item.output),
          });
        }
      }
    }
  }

  return input;
}

// ============================================================
// Tests
// ============================================================

describe("buildInputFromSteps", () => {
  it("should include user message with prompt", () => {
    idCounter = 0;
    const result = buildInputFromSteps([], "What is the weather in SF?");

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      role: "user",
      content: [
        {
          type: "input_text",
          text: "What is the weather in SF?",
        },
      ],
    });
  });

  it("should extract function_call with arguments from tool-call content", () => {
    idCounter = 0;
    const result = buildInputFromSteps(mockStepsWithToolCalls, undefined);

    // Find function calls
    const functionCalls = result.filter(
      (item: unknown) => (item as { type: string }).type === "function_call"
    );

    expect(functionCalls).toHaveLength(2);

    // First function call: weather
    const weatherCall = functionCalls[0] as {
      type: string;
      id: string;
      call_id: string;
      name: string;
      arguments: string;
    };
    expect(weatherCall.type).toBe("function_call");
    expect(weatherCall.call_id).toBe("call_abc123");
    expect(weatherCall.name).toBe("weather");
    expect(weatherCall.arguments).toBe('{"location":"San Francisco"}');

    // Second function call: convertFahrenheitToCelsius
    const convertCall = functionCalls[1] as {
      type: string;
      id: string;
      call_id: string;
      name: string;
      arguments: string;
    };
    expect(convertCall.type).toBe("function_call");
    expect(convertCall.call_id).toBe("call_def456");
    expect(convertCall.name).toBe("convertFahrenheitToCelsius");
    expect(convertCall.arguments).toBe('{"temperature":72}');
  });

  it("should extract function_call_output with output from tool-result content", () => {
    idCounter = 0;
    const result = buildInputFromSteps(mockStepsWithToolCalls, undefined);

    // Find function call outputs
    const functionCallOutputs = result.filter(
      (item: unknown) =>
        (item as { type: string }).type === "function_call_output"
    );

    expect(functionCallOutputs).toHaveLength(2);

    // First output: weather result
    const weatherOutput = functionCallOutputs[0] as {
      type: string;
      call_id: string;
      output: string;
    };
    expect(weatherOutput.type).toBe("function_call_output");
    expect(weatherOutput.call_id).toBe("call_abc123");
    expect(weatherOutput.output).toBe(
      '{"location":"San Francisco","temperature":72}'
    );

    // Second output: celsius conversion result
    const convertOutput = functionCallOutputs[1] as {
      type: string;
      call_id: string;
      output: string;
    };
    expect(convertOutput.type).toBe("function_call_output");
    expect(convertOutput.call_id).toBe("call_def456");
    expect(convertOutput.output).toBe('{"celsius":22}');
  });

  it("should build complete input array matching OpenResponses format", () => {
    idCounter = 0;
    const result = buildInputFromSteps(
      mockStepsWithToolCalls,
      "What is the weather in San Francisco?"
    );

    // Should have:
    // 1 user message + 2 function calls + 2 function call outputs = 5 items
    expect(result).toHaveLength(5);

    // Verify order: user message first
    expect((result[0] as { role: string }).role).toBe("user");

    // Then function calls and outputs interleaved
    expect((result[1] as { type: string }).type).toBe("function_call");
    expect((result[2] as { type: string }).type).toBe("function_call_output");
    expect((result[3] as { type: string }).type).toBe("function_call");
    expect((result[4] as { type: string }).type).toBe("function_call_output");
  });

  it("should handle string input/output without double-stringifying", () => {
    const stepsWithStringValues = [
      {
        content: [
          {
            type: "tool-call",
            toolCallId: "call_str",
            toolName: "echo",
            input: "hello world",
          },
          {
            type: "tool-result",
            toolCallId: "call_str",
            output: "hello world echoed",
          },
        ],
      },
    ];

    idCounter = 0;
    const result = buildInputFromSteps(stepsWithStringValues, undefined);

    const functionCall = result.find(
      (item: unknown) => (item as { type: string }).type === "function_call"
    ) as { arguments: string };
    const functionOutput = result.find(
      (item: unknown) =>
        (item as { type: string }).type === "function_call_output"
    ) as { output: string };

    expect(functionCall.arguments).toBe("hello world");
    expect(functionOutput.output).toBe("hello world echoed");
  });

  it("should skip non-tool content items", () => {
    const stepsWithTextOnly = [
      {
        content: [
          {
            type: "text",
            text: "Just some text response",
          },
        ],
      },
    ];

    idCounter = 0;
    const result = buildInputFromSteps(stepsWithTextOnly, "Hello");

    // Should only have the user message, no function calls
    expect(result).toHaveLength(1);
    expect((result[0] as { role: string }).role).toBe("user");
  });
});
