import { execFile } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

import { envText } from "../common/env-config.js";
import { pythonStrip } from "../common/sanitize.js";

const KEY_ENV = "EVALUATORQ_DASHBOARD_KEY_ENCRYPTION_KEY",
  KEYCHAIN_SERVICE = "evaluatorq-dashboard-api-key-encryption",
  DECRYPT_ERROR =
    "The saved API key cannot be decrypted. Restore its original encryption key or enter it again.";
const execute = promisify(execFile);
let cachedKey: Promise<Buffer> | undefined;
export function clearEncryptionKeyCache(): void {
  cachedKey = undefined;
}
function decodeBase64(value: string): Buffer {
  if (Array.from(value).some((char) => char.charCodeAt(0) > 127))
    throw new Error("Non-ASCII encoding");
  const cleaned = value.replace(/[^a-zA-Z0-9_+/=-]/g, "");
  if (!cleaned.includes("=") && cleaned.length % 4 !== 0)
    throw new Error("Incorrect base64 padding");
  return Buffer.from(cleaned, "base64url");
}
function decodeKey(value: string): Buffer {
  const key = decodeBase64(value);
  if (key.length !== 32) throw new Error("Invalid Fernet key");
  return key;
}
const base64Url = (value: Buffer): string =>
  value.toString("base64").replaceAll("+", "-").replaceAll("/", "_");
async function encryptionKey(): Promise<Buffer> {
  if (cachedKey) return cachedKey;
  const pending = async () => {
    const configured = envText(KEY_ENV);
    if (configured) {
      try {
        return decodeKey(configured);
      } catch {
        throw new Error(`${KEY_ENV} must contain a valid Fernet key.`);
      }
    }
    if (process.platform !== "darwin")
      throw new Error(
        `Encrypted API-key storage needs macOS Keychain or ${KEY_ENV} on this platform.`,
      );
    const account = process.env.USER ?? "evaluatorq";
    let existing: string | undefined;
    try {
      const result = await execute(
        "security",
        ["find-generic-password", "-a", account, "-s", KEYCHAIN_SERVICE, "-w"],
        { encoding: "utf8" },
      );
      existing = pythonStrip(result.stdout) || undefined;
    } catch {}
    if (existing) {
      try {
        return decodeKey(existing);
      } catch {
        throw new Error("The dashboard encryption key in Keychain is invalid.");
      }
    }
    const key = randomBytes(32);
    try {
      await execute(
        "security",
        [
          "add-generic-password",
          "-U",
          "-a",
          account,
          "-s",
          KEYCHAIN_SERVICE,
          "-w",
          base64Url(key),
        ],
        { encoding: "utf8" },
      );
    } catch {
      throw new Error(
        "Could not save the dashboard encryption key in macOS Keychain.",
      );
    }
    return key;
  };
  cachedKey = pending();
  try {
    return await cachedKey;
  } catch (error) {
    cachedKey = undefined;
    throw error;
  }
}
export async function encryptApiKey(value: string): Promise<string> {
  const key = await encryptionKey(),
    iv = randomBytes(16),
    header = Buffer.alloc(9);
  header[0] = 0x80;
  header.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)), 1);
  const cipher = createCipheriv("aes-128-cbc", key.subarray(16), iv),
    ciphertext = Buffer.concat([
      cipher.update(Buffer.from(value, "utf8")),
      cipher.final(),
    ]),
    message = Buffer.concat([header, iv, ciphertext]),
    signature = createHmac("sha256", key.subarray(0, 16))
      .update(message)
      .digest();
  return base64Url(Buffer.concat([message, signature]));
}
export async function decryptApiKey(ciphertext: string): Promise<string> {
  const key = await encryptionKey();
  try {
    const token = decodeBase64(ciphertext);
    if (
      token.length < 73 ||
      token[0] !== 0x80 ||
      (token.length - 57) % 16 !== 0
    )
      throw new Error("Invalid Fernet token");
    const message = token.subarray(0, -32),
      signature = token.subarray(-32),
      expected = createHmac("sha256", key.subarray(0, 16))
        .update(message)
        .digest();
    if (!timingSafeEqual(signature, expected))
      throw new Error("Invalid Fernet signature");
    const decipher = createDecipheriv(
        "aes-128-cbc",
        key.subarray(16),
        token.subarray(9, 25),
      ),
      plain = Buffer.concat([
        decipher.update(token.subarray(25, -32)),
        decipher.final(),
      ]);
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      plain,
    );
  } catch {
    throw new Error(DECRYPT_ERROR);
  }
}
