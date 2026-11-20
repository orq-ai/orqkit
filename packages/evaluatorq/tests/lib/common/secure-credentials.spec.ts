import { afterEach, beforeEach, expect, it } from "bun:test";

import {
  clearEncryptionKeyCache,
  decryptApiKey,
  encryptApiKey,
} from "../../../src/lib/trace-finder/secure-credentials.js";
import goldens from "../fixtures/credentials-python-goldens.json" with {
  type: "json",
};

let previous: string | undefined;
beforeEach(() => {
  previous = process.env.EVALUATORQ_DASHBOARD_KEY_ENCRYPTION_KEY;
  process.env.EVALUATORQ_DASHBOARD_KEY_ENCRYPTION_KEY =
    goldens.syntheticEncryptionKey;
  clearEncryptionKeyCache();
});
afterEach(() => {
  clearEncryptionKeyCache();
  if (previous === undefined)
    delete process.env.EVALUATORQ_DASHBOARD_KEY_ENCRYPTION_KEY;
  else process.env.EVALUATORQ_DASHBOARD_KEY_ENCRYPTION_KEY = previous;
});
for (const [index, row] of goldens.cases.entries())
  it(`decrypts pinned Python Fernet token ${index}`, async () =>
    expect(await decryptApiKey(row.token)).toBe(row.decoded));
for (const [index, row] of goldens.invalid.entries())
  it(`rejects invalid token safely ${index}`, async () => {
    if (row.error)
      await expect(decryptApiKey(row.token)).rejects.toThrow(row.error);
  });
it("encrypts with fresh IVs and roundtrips Unicode without exposing the key", async () => {
  const plain = "synthetic-api-key-😀",
    [a, b] = await Promise.all([encryptApiKey(plain), encryptApiKey(plain)]);
  expect(a).not.toBe(b);
  expect(a).not.toContain(plain);
  expect(await decryptApiKey(a)).toBe(plain);
  expect(await decryptApiKey(b)).toBe(plain);
  const token = Buffer.from(a, "base64url");
  token[30] = (token[30] ?? 0) ^ 1;
  await expect(
    decryptApiKey(token.toString("base64url") + "="),
  ).rejects.toThrow("The saved API key cannot be decrypted.");
});
it("reports malformed explicit encryption keys without echoing their value", async () => {
  process.env.EVALUATORQ_DASHBOARD_KEY_ENCRYPTION_KEY =
    "synthetic-secret-invalid";
  clearEncryptionKeyCache();
  try {
    await encryptApiKey("synthetic-key");
    throw new Error("Should reject");
  } catch (error) {
    expect((error as Error).message).toBe(
      "EVALUATORQ_DASHBOARD_KEY_ENCRYPTION_KEY must contain a valid Fernet key.",
    );
    expect((error as Error).message).not.toContain("synthetic-secret-invalid");
  }
});
