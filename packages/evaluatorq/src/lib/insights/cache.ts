import { createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { getStoreDir } from "../common/run-store-dir.js";
import { type TraceSummary, TraceSummarySchema } from "./models.js";

interface Statement {
  get(...args: (string | number | Uint8Array)[]): unknown;
  all(...args: (string | number | Uint8Array)[]): unknown[];
  run(...args: (string | number | Uint8Array)[]): unknown;
}
interface Database {
  exec(sql: string): unknown;
  prepare(sql: string): Statement;
  close(): void;
}
const schema = `CREATE TABLE IF NOT EXISTS summaries (trace_id TEXT NOT NULL, span_id TEXT NOT NULL, model TEXT NOT NULL, prompt_hash TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (trace_id, span_id, model, prompt_hash));
CREATE TABLE IF NOT EXISTS vectors (model TEXT NOT NULL, text_hash TEXT NOT NULL, vector BLOB NOT NULL, PRIMARY KEY (model, text_hash));`;
export const promptHash = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");
export function packVector(vector: readonly number[]): Buffer {
  if (!vector.length) throw new Error("vector cannot be empty");
  if (
    !vector.every(
      (value) =>
        typeof value === "number" &&
        Number.isFinite(value) &&
        Number.isFinite(Math.fround(value)),
    )
  )
    throw new Error(
      "vector values must be finite and representable as float32",
    );
  const payload = Buffer.alloc(vector.length * 4);
  vector.forEach((value, index) => {
    payload.writeFloatBE(value, index * 4);
  });
  const length = Buffer.alloc(4);
  length.writeUInt32BE(vector.length);
  return Buffer.concat([
    Buffer.from("EQV2"),
    length,
    createHash("sha256").update(payload).digest(),
    payload,
  ]);
}
export function unpackVector(value: Uint8Array): number[] {
  const blob = Buffer.from(value);
  if (blob.length < 40 || blob.subarray(0, 4).toString() !== "EQV2")
    throw new Error("missing vector integrity header");
  const length = blob.readUInt32BE(4),
    payload = blob.subarray(40);
  if (!length || payload.length !== length * 4)
    throw new Error("vector length does not match header");
  if (
    !timingSafeEqual(
      createHash("sha256").update(payload).digest(),
      blob.subarray(8, 40),
    )
  )
    throw new Error("vector checksum does not match header");
  const vector = Array.from({ length }, (_, i) => payload.readFloatBE(i * 4));
  if (!vector.every(Number.isFinite))
    throw new Error("vector values must be finite");
  return vector;
}
export class InsightsCache {
  private constructor(private db: Database | null) {}
  static async open(
    options: { path?: string; enabled?: boolean } = {},
  ): Promise<InsightsCache> {
    if (options.enabled === false) return new InsightsCache(null);
    const path = options.path ?? join(getStoreDir("cache"), "insights.sqlite");
    let db: Database | null = null;
    try {
      mkdirSync(dirname(path), { recursive: true });
      const isBun = Boolean(
          (process.versions as Record<string, string | undefined>).bun,
        ),
        moduleName = isBun ? "bun:sqlite" : "node:sqlite",
        module = (await import(moduleName)) as Record<
          string,
          new (
            path: string,
          ) => Database
        >;
      const Constructor = module[isBun ? "Database" : "DatabaseSync"];
      if (!Constructor) throw new Error("SQLite is unavailable");
      db = new Constructor(path);
      db.exec("PRAGMA busy_timeout = 30000");
      db.exec(schema);
      return new InsightsCache(db);
    } catch (error) {
      console.warn(
        `InsightsCache: failed to open/migrate ${path}: ${error instanceof Error ? error.message : String(error)}; caching disabled for this run`,
      );
      try {
        db?.close();
      } catch {}
      return new InsightsCache(null);
    }
  }
  getSummary(
    traceId: string,
    spanId: string,
    model: string,
    hash: string,
  ): TraceSummary | null {
    if (!this.db) return null;
    try {
      const row = this.db
        .prepare(
          "SELECT payload FROM summaries WHERE trace_id = ? AND span_id = ? AND model = ? AND prompt_hash = ?",
        )
        .get(traceId, spanId, model, hash) as { payload?: unknown } | undefined;
      if (!row) return null;
      if (typeof row.payload !== "string")
        throw new Error("invalid summary payload");
      return TraceSummarySchema.parse(JSON.parse(row.payload));
    } catch (error) {
      console.warn(
        `InsightsCache.getSummary: ${error instanceof Error ? error.message : String(error)}; treating as a miss`,
      );
      return null;
    }
  }
  putSummary(
    traceId: string,
    spanId: string,
    model: string,
    hash: string,
    summary: TraceSummary,
  ): void {
    if (!this.db) return;
    try {
      this.db
        .prepare(
          "INSERT OR REPLACE INTO summaries (trace_id, span_id, model, prompt_hash, payload) VALUES (?, ?, ?, ?, ?)",
        )
        .run(traceId, spanId, model, hash, JSON.stringify(summary));
    } catch (error) {
      console.warn(
        `InsightsCache.putSummary: ${error instanceof Error ? error.message : String(error)}; summary not cached`,
      );
    }
  }
  getVectors(model: string, texts: Iterable<string>): Record<string, number[]> {
    const hashToText = new Map(
      [...texts].map((text) => [promptHash(text), text]),
    );
    if (!this.db || !hashToText.size) return {};
    try {
      const hashes = [...hashToText.keys()],
        found: [string, number[]][] = [];
      let invalid = 0;
      for (let i = 0; i < hashes.length; i += 500) {
        const chunk = hashes.slice(i, i + 500),
          rows = this.db
            .prepare(
              `SELECT text_hash, vector FROM vectors WHERE model = ? AND text_hash IN (${chunk.map(() => "?").join(",")})`,
            )
            .all(model, ...chunk) as {
            text_hash: string;
            vector: Uint8Array;
          }[];
        for (const row of rows) {
          const text = hashToText.get(row.text_hash);
          if (text === undefined) continue;
          try {
            found.push([text, unpackVector(row.vector)]);
          } catch {
            invalid++;
          }
        }
      }
      if (invalid)
        console.warn(
          `InsightsCache.getVectors: ${invalid} incompatible or corrupt cached vector(s); treating as misses`,
        );
      return Object.fromEntries(found);
    } catch (error) {
      console.warn(
        `InsightsCache.getVectors: ${error instanceof Error ? error.message : String(error)}; treating as a miss`,
      );
      return {};
    }
  }
  putVectors(
    model: string,
    vectors: Readonly<Record<string, readonly number[]>>,
  ): void {
    if (!this.db) return;
    const rows: [string, Buffer][] = [];
    let invalid = 0;
    for (const [text, vector] of Object.entries(vectors))
      try {
        rows.push([promptHash(text), packVector(vector)]);
      } catch {
        invalid++;
      }
    if (invalid)
      console.warn(
        `InsightsCache.putVectors: skipping ${invalid} invalid vector(s)`,
      );
    if (!rows.length) return;
    try {
      this.db.exec("BEGIN");
      const stmt = this.db.prepare(
        "INSERT OR REPLACE INTO vectors (model, text_hash, vector) VALUES (?, ?, ?)",
      );
      for (const [hash, vector] of rows) stmt.run(model, hash, vector);
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      console.warn(
        `InsightsCache.putVectors: ${error instanceof Error ? error.message : String(error)}; vectors not cached`,
      );
    }
  }
  deleteVectors(model: string): void {
    if (!this.db) return;
    try {
      this.db.prepare("DELETE FROM vectors WHERE model = ?").run(model);
    } catch (error) {
      console.warn(
        `InsightsCache.deleteVectors: ${error instanceof Error ? error.message : String(error)}; vectors remain cached`,
      );
    }
  }
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
