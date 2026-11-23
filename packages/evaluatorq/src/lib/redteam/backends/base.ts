import { randomUUID } from "node:crypto";

import { ZodError } from "zod";
import { ZodError as Zod4Error } from "zod/v4";

import { defaultMapError, type MappedError } from "../../common/target-call.js";
import {
  type AgentContext,
  AgentContextSchema,
  AgentTarget,
} from "../../contracts.js";
export function validateAgentTarget(value: unknown): void {
  const target = value as {
    respond?: unknown;
    newInstance?: unknown;
    clone?: unknown;
  } | null;
  if (
    typeof target?.respond !== "function" &&
    typeof target?.newInstance !== "function" &&
    typeof target?.clone === "function"
  )
    throw new TypeError(
      "The clone() target API was removed; implement respond() and newInstance() instead.",
    );
}
export interface MemoryCleanupOptions {
  signal?: AbortSignal;
}
export abstract class Backend {
  protected readonly contextCache = new Map<string, AgentContext>();
  constructor(readonly name: string) {}
  abstract createTarget(key: string): AgentTarget;
  abstract cleanupMemory(
    context: AgentContext,
    entityIds: string[],
    options?: MemoryCleanupOptions,
  ): Promise<void>;
  mapError(error: unknown): MappedError {
    return defaultMapError(error);
  }
  async resolveContext(key: string): Promise<AgentContext> {
    const known = this.contextCache.get(key);
    if (known) return known;
    const probe = this.createTarget(key);
    let context: AgentContext;
    try {
      context = AgentContextSchema.parse(await probe.getAgentContext());
    } catch (error) {
      if (!(error instanceof ZodError) && !(error instanceof Zod4Error))
        throw error;
      console.warn(
        `Could not model agent context for ${key}; continuing with limited context`,
        error,
      );
      context = AgentContextSchema.parse({ key });
    }
    this.contextCache.set(key, context);
    return context;
  }
}
export interface HybridAgentBackendOptions {
  execBackend: Backend;
  contextBackend?: Backend;
  contextBackendFactory?: () => Backend;
}
export class HybridAgentBackend extends Backend {
  private cached?: Backend;
  constructor(readonly options: HybridAgentBackendOptions) {
    super("hybrid-agent");
    if (
      Boolean(options.contextBackend) === Boolean(options.contextBackendFactory)
    )
      throw new Error(
        "Provide exactly one of contextBackend or contextBackendFactory",
      );
    this.cached = options.contextBackend;
  }
  private context(): Backend {
    if (this.cached) return this.cached;
    if (!this.options.contextBackendFactory)
      throw new Error("No context backend configured");
    this.cached = this.options.contextBackendFactory();
    return this.cached;
  }
  override createTarget(key: string): AgentTarget {
    const target = this.options.execBackend.createTarget(
      `agent/${key.startsWith("agent/") ? key.slice(6) : key}`,
    );
    if (target.memoryEntityId === null)
      target.mintMemoryEntityId(
        `red-team-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
      );
    return target;
  }
  override resolveContext(key: string): Promise<AgentContext> {
    return this.context().resolveContext(key);
  }
  override cleanupMemory(
    context: AgentContext,
    ids: string[],
    options?: MemoryCleanupOptions,
  ): Promise<void> {
    return this.context().cleanupMemory(context, ids, options);
  }
  override mapError(error: unknown): MappedError {
    return this.options.execBackend.mapError(error);
  }
}
export class BareTargetBackend extends Backend {
  constructor(readonly target: AgentTarget) {
    super(target.constructor.name);
  }
  override createTarget(_key: string): AgentTarget {
    return this.target.newInstance();
  }
  override async cleanupMemory(
    context: AgentContext,
    ids: string[],
    options?: MemoryCleanupOptions,
  ): Promise<void> {
    if (
      ids.length &&
      this.target.cleanupMemory === AgentTarget.prototype.cleanupMemory
    )
      console.warn(
        `BareTargetBackend: ${this.target.constructor.name} created ${ids.length} memory entity id(s) but does not implement cleanupMemory; they may persist.`,
      );
    await this.target.cleanupMemory(context, ids, options);
  }
  override mapError(error: unknown): MappedError {
    return this.target.mapError(error) ?? super.mapError(error);
  }
}
