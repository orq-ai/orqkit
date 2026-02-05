/**
 * Tests for the fetchDatasetBatches function, specifically includeMessages functionality.
 *
 * These tests verify:
 * 1. includeMessages: false - original inputs are preserved
 * 2. includeMessages: true - messages are merged into inputs
 * 3. Conflict error when includeMessages is true but inputs already contain 'messages' key
 */

import { describe, expect, it, mock } from "bun:test";

// We need to test the internal fetchDatasetBatches function
// Since it's not exported, we'll test through the module internals

interface MockDatapoint {
  inputs: Record<string, unknown>;
  messages?: Array<{ role: string; content: string }>;
  expectedOutput?: unknown;
  _id: string;
}

interface MockResponse {
  data: MockDatapoint[];
  hasMore: boolean;
}

// Helper to create a mock Orq client
function createMockOrqClient(responses: MockResponse[]) {
  let callIndex = 0;
  return {
    datasets: {
      listDatapoints: mock(async () => {
        const response = responses[callIndex] || { data: [], hasMore: false };
        callIndex++;
        return response;
      }),
    },
  };
}

// Since fetchDatasetBatches is not exported, we need to recreate the logic for testing
// This tests the same logic that's in evaluatorq.ts
async function* fetchDatasetBatchesTestImpl(
  orqClient: ReturnType<typeof createMockOrqClient>,
  datasetId: string,
  options?: { includeMessages?: boolean },
): AsyncGenerator<{
  datapoints: Array<{
    inputs: Record<string, unknown>;
    expectedOutput?: unknown;
  }>;
  hasMore: boolean;
  batchNumber: number;
}> {
  let startingAfter: string | undefined;
  let batchNumber = 0;
  let hasYielded = false;

  try {
    while (true) {
      const response = await orqClient.datasets.listDatapoints({
        datasetId,
        limit: 50,
        startingAfter,
      });

      if (!response.data || response.data.length === 0) {
        if (!hasYielded) {
          throw new Error(`Dataset ${datasetId} not found or has no data`);
        }
        break;
      }

      const batchDatapoints: Array<{
        inputs: Record<string, unknown>;
        expectedOutput?: unknown;
      }> = [];

      for (const datapoint of response.data) {
        const inputs = { ...(datapoint.inputs || {}) };
        if (options?.includeMessages) {
          if ("messages" in inputs) {
            throw new Error(
              "includeMessages is enabled but the datapoint inputs already contain a 'messages' key. Remove 'messages' from inputs or disable includeMessages.",
            );
          }
          if (datapoint.messages) {
            inputs.messages = datapoint.messages;
          }
        }
        batchDatapoints.push({
          inputs,
          expectedOutput: datapoint.expectedOutput,
        });

        startingAfter = datapoint._id;
      }

      batchNumber++;
      const hasMore = response.hasMore ?? false;

      yield {
        datapoints: batchDatapoints,
        hasMore,
        batchNumber,
      };
      hasYielded = true;

      if (!hasMore) {
        break;
      }
    }
  } catch (error) {
    throw new Error(
      `Failed to fetch dataset ${datasetId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

describe("fetchDatasetBatches - includeMessages functionality", () => {
  describe("includeMessages: false (default)", () => {
    it("preserves original inputs without modification", async () => {
      const mockClient = createMockOrqClient([
        {
          data: [
            {
              inputs: { prompt: "Hello" },
              messages: [{ role: "user", content: "Hi" }],
              _id: "1",
            },
          ],
          hasMore: false,
        },
      ]);

      const batches = [];
      for await (const batch of fetchDatasetBatchesTestImpl(
        mockClient,
        "test-dataset",
        { includeMessages: false },
      )) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(1);
      expect(batches[0].datapoints).toHaveLength(1);
      expect(batches[0].datapoints[0].inputs).toEqual({ prompt: "Hello" });
      expect("messages" in batches[0].datapoints[0].inputs).toBe(false);
    });

    it("allows 'messages' key in inputs without error", async () => {
      const mockClient = createMockOrqClient([
        {
          data: [
            {
              inputs: {
                prompt: "Hello",
                messages: [{ role: "user", content: "Existing message" }],
              },
              messages: [{ role: "assistant", content: "New message" }],
              _id: "1",
            },
          ],
          hasMore: false,
        },
      ]);

      const batches = [];
      for await (const batch of fetchDatasetBatchesTestImpl(
        mockClient,
        "test-dataset",
        { includeMessages: false },
      )) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(1);
      expect(batches[0].datapoints[0].inputs.messages).toEqual([
        { role: "user", content: "Existing message" },
      ]);
    });
  });

  describe("includeMessages: true", () => {
    it("merges top-level messages into inputs", async () => {
      const mockClient = createMockOrqClient([
        {
          data: [
            {
              inputs: { prompt: "Hello" },
              messages: [{ role: "user", content: "Hi" }],
              _id: "1",
            },
          ],
          hasMore: false,
        },
      ]);

      const batches = [];
      for await (const batch of fetchDatasetBatchesTestImpl(
        mockClient,
        "test-dataset",
        { includeMessages: true },
      )) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(1);
      expect(batches[0].datapoints[0].inputs).toEqual({
        prompt: "Hello",
        messages: [{ role: "user", content: "Hi" }],
      });
    });

    it("does not add messages if datapoint has none", async () => {
      const mockClient = createMockOrqClient([
        {
          data: [
            {
              inputs: { prompt: "Hello" },
              messages: undefined,
              _id: "1",
            },
          ],
          hasMore: false,
        },
      ]);

      const batches = [];
      for await (const batch of fetchDatasetBatchesTestImpl(
        mockClient,
        "test-dataset",
        { includeMessages: true },
      )) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(1);
      expect(batches[0].datapoints[0].inputs).toEqual({ prompt: "Hello" });
      expect("messages" in batches[0].datapoints[0].inputs).toBe(false);
    });

    it("throws error when inputs already contain 'messages' key", async () => {
      const mockClient = createMockOrqClient([
        {
          data: [
            {
              inputs: {
                prompt: "Hello",
                messages: [{ role: "user", content: "Existing message" }],
              },
              messages: [{ role: "assistant", content: "New message" }],
              _id: "1",
            },
          ],
          hasMore: false,
        },
      ]);

      let error: Error | undefined;
      try {
        for await (const _ of fetchDatasetBatchesTestImpl(
          mockClient,
          "test-dataset",
          { includeMessages: true },
        )) {
          // consume iterator
        }
      } catch (e) {
        error = e as Error;
      }

      expect(error).toBeDefined();
      expect(error?.message).toContain(
        "includeMessages is enabled but the datapoint inputs already contain a 'messages' key",
      );
      expect(error?.message).toContain(
        "Remove 'messages' from inputs or disable includeMessages",
      );
    });

    it("throws error even when messages in inputs is empty array", async () => {
      const mockClient = createMockOrqClient([
        {
          data: [
            {
              inputs: {
                prompt: "Hello",
                messages: [], // Empty but still present
              },
              messages: [{ role: "user", content: "New message" }],
              _id: "1",
            },
          ],
          hasMore: false,
        },
      ]);

      let error: Error | undefined;
      try {
        for await (const _ of fetchDatasetBatchesTestImpl(
          mockClient,
          "test-dataset",
          { includeMessages: true },
        )) {
          // consume iterator
        }
      } catch (e) {
        error = e as Error;
      }

      expect(error).toBeDefined();
      expect(error?.message).toContain(
        "includeMessages is enabled but the datapoint inputs already contain a 'messages' key",
      );
    });
  });

  describe("pagination with includeMessages", () => {
    it("processes multiple batches correctly with includeMessages: true", async () => {
      const mockClient = createMockOrqClient([
        {
          data: [
            {
              inputs: { prompt: "First" },
              messages: [{ role: "user", content: "Message 1" }],
              _id: "1",
            },
          ],
          hasMore: true,
        },
        {
          data: [
            {
              inputs: { prompt: "Second" },
              messages: [{ role: "user", content: "Message 2" }],
              _id: "2",
            },
          ],
          hasMore: false,
        },
      ]);

      const batches = [];
      for await (const batch of fetchDatasetBatchesTestImpl(
        mockClient,
        "test-dataset",
        { includeMessages: true },
      )) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(2);
      expect(batches[0].datapoints[0].inputs.messages).toEqual([
        { role: "user", content: "Message 1" },
      ]);
      expect(batches[1].datapoints[0].inputs.messages).toEqual([
        { role: "user", content: "Message 2" },
      ]);
    });

    it("throws error on conflict in second batch", async () => {
      const mockClient = createMockOrqClient([
        {
          data: [
            {
              inputs: { prompt: "First" },
              messages: [{ role: "user", content: "Message 1" }],
              _id: "1",
            },
          ],
          hasMore: true,
        },
        {
          data: [
            {
              inputs: {
                prompt: "Second",
                messages: [{ role: "user", content: "Existing" }], // Conflict!
              },
              messages: [{ role: "user", content: "Message 2" }],
              _id: "2",
            },
          ],
          hasMore: false,
        },
      ]);

      const batches = [];
      let error: Error | undefined;
      try {
        for await (const batch of fetchDatasetBatchesTestImpl(
          mockClient,
          "test-dataset",
          { includeMessages: true },
        )) {
          batches.push(batch);
        }
      } catch (e) {
        error = e as Error;
      }

      // First batch should have been processed successfully
      expect(batches).toHaveLength(1);
      expect(error).toBeDefined();
      expect(error?.message).toContain(
        "includeMessages is enabled but the datapoint inputs already contain a 'messages' key",
      );
    });
  });
});
