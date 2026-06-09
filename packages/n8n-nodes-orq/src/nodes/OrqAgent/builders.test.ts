import { describe, expect, test } from "bun:test";

import {
  buildCreateResponseBody,
  toMetadataMap,
  toVariablesMap,
} from "./builders";

describe("toVariablesMap", () => {
  test("returns undefined for empty / undefined input", () => {
    expect(toVariablesMap(undefined)).toBeUndefined();
    expect(toVariablesMap([])).toBeUndefined();
  });

  test("skips rows with blank names and trims the name", () => {
    expect(toVariablesMap([{ name: "  ", value: "x" }])).toBeUndefined();
    expect(toVariablesMap([{ name: " a ", value: "x" }])).toEqual({ a: "x" });
  });

  test("wraps secret values, leaves plain values as strings", () => {
    expect(
      toVariablesMap([
        { name: "plain", value: "v1" },
        { name: "token", value: "v2", isSecret: true },
      ]),
    ).toEqual({ plain: "v1", token: { secret: true, value: "v2" } });
  });

  test("defaults a missing value to empty string", () => {
    expect(toVariablesMap([{ name: "a" }])).toEqual({ a: "" });
  });

  test("throws on duplicate variable names", () => {
    expect(() =>
      toVariablesMap([
        { name: "dup", value: "1" },
        { name: "dup", value: "2" },
      ]),
    ).toThrow('Duplicate variable name: "dup"');
  });
});

describe("toMetadataMap", () => {
  test("returns undefined for empty / undefined input", () => {
    expect(toMetadataMap(undefined)).toBeUndefined();
    expect(toMetadataMap([])).toBeUndefined();
  });

  test("builds a string map, skipping blank names", () => {
    expect(
      toMetadataMap([
        { name: "env", value: "prod" },
        { name: " ", value: "ignored" },
      ]),
    ).toEqual({ env: "prod" });
  });

  test("throws on duplicate metadata names", () => {
    expect(() =>
      toMetadataMap([
        { name: "k", value: "1" },
        { name: "k", value: "2" },
      ]),
    ).toThrow('Duplicate metadata name: "k"');
  });

  test("enforces the 16-pair maximum", () => {
    const rows = Array.from({ length: 17 }, (_, i) => ({
      name: `k${i}`,
      value: "v",
    }));
    expect(() => toMetadataMap(rows)).toThrow(
      "Metadata exceeds the maximum of 16 pairs (got 17)",
    );
    const ok = Array.from({ length: 16 }, (_, i) => ({
      name: `k${i}`,
      value: "v",
    }));
    expect(Object.keys(toMetadataMap(ok) ?? {})).toHaveLength(16);
  });
});

describe("buildCreateResponseBody", () => {
  test("minimal body: prefixes model with agent/, trims, stream=false", () => {
    expect(
      buildCreateResponseBody({ agentKey: " my-agent ", input: "  hi  " }),
    ).toEqual({ model: "agent/my-agent", input: "hi", stream: false });
  });

  test("includes store only when it is a boolean", () => {
    expect(
      buildCreateResponseBody({ agentKey: "a", input: "i", store: false }).store,
    ).toBe(false);
    expect(
      buildCreateResponseBody({ agentKey: "a", input: "i" }).store,
    ).toBeUndefined();
  });

  test("maps threading + memory fields when provided (trimmed)", () => {
    const body = buildCreateResponseBody({
      agentKey: "a",
      input: "i",
      previousResponseId: " resp_1 ",
      memoryEntityId: " ent_1 ",
    });
    expect(body.previous_response_id).toBe("resp_1");
    expect(body.memory).toEqual({ entity_id: "ent_1" });
  });

  test("wraps conversation id under conversation.id", () => {
    expect(
      buildCreateResponseBody({ agentKey: "a", input: "i", conversationId: "c1" })
        .conversation,
    ).toEqual({ id: "c1" });
  });

  test("omits blank optional fields", () => {
    const body = buildCreateResponseBody({
      agentKey: "a",
      input: "i",
      previousResponseId: "   ",
      conversationId: "",
      memoryEntityId: "",
    });
    expect(body.previous_response_id).toBeUndefined();
    expect(body.conversation).toBeUndefined();
    expect(body.memory).toBeUndefined();
  });

  test("attaches variables and metadata maps when present", () => {
    const body = buildCreateResponseBody({
      agentKey: "a",
      input: "i",
      variables: [{ name: "v", value: "1", isSecret: true }],
      metadata: [{ name: "m", value: "2" }],
    });
    expect(body.variables).toEqual({ v: { secret: true, value: "1" } });
    expect(body.metadata).toEqual({ m: "2" });
  });
});
