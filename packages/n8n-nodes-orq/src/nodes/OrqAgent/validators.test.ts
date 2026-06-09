import { describe, expect, test } from "bun:test";
import type { INode } from "n8n-workflow";

import {
  validateAgentKey,
  validateCredentials,
  validateMessage,
  validateThreadingExclusivity,
} from "./validators";

// NodeOperationError only reads node identity fields; a minimal stub is enough.
const node = { name: "OrqAgent", type: "orqAgent", typeVersion: 1 } as unknown as INode;

describe("validateAgentKey", () => {
  test("throws on empty / whitespace", () => {
    expect(() => validateAgentKey("", node)).toThrow("Agent Key is required");
    expect(() => validateAgentKey("   ", node)).toThrow("Agent Key is required");
  });
  test("accepts a non-empty key", () => {
    expect(() => validateAgentKey("my-agent", node)).not.toThrow();
  });
});

describe("validateMessage", () => {
  test("throws on empty / whitespace", () => {
    expect(() => validateMessage("", node)).toThrow("Message is required");
    expect(() => validateMessage("  ", node)).toThrow("Message is required");
  });
  test("accepts a non-empty message", () => {
    expect(() => validateMessage("hello", node)).not.toThrow();
  });
});

describe("validateCredentials", () => {
  test("throws when credentials are missing", () => {
    expect(() => validateCredentials(undefined, node)).toThrow(
      "No credentials configured. Please add Orq API credentials.",
    );
  });
  test("throws when apiKey is absent", () => {
    expect(() => validateCredentials({}, node)).toThrow(
      "API Key is required in credentials",
    );
  });
  test("accepts credentials with an apiKey", () => {
    expect(() => validateCredentials({ apiKey: "sk-x" }, node)).not.toThrow();
  });
});

describe("validateThreadingExclusivity", () => {
  test("throws when both previous_response_id and conversation id are set", () => {
    expect(() => validateThreadingExclusivity("resp_1", "conv_1", node)).toThrow(
      "Conversation ID and Previous Response ID are mutually exclusive",
    );
  });
  test("allows exactly one, or neither", () => {
    expect(() => validateThreadingExclusivity("resp_1", undefined, node)).not.toThrow();
    expect(() => validateThreadingExclusivity(undefined, "conv_1", node)).not.toThrow();
    expect(() => validateThreadingExclusivity("", "  ", node)).not.toThrow();
    expect(() => validateThreadingExclusivity(undefined, undefined, node)).not.toThrow();
  });
});
