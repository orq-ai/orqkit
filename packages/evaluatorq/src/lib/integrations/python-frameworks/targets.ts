import { randomUUID } from "node:crypto";

import { fromPythonKeys, toPythonKeys } from "../../common/python-json.js";
import {
  type AgentContext,
  AgentContextSchema,
  AgentResponse,
  AgentTarget,
  type MessageInput,
  MessageSchema,
} from "../../contracts.js";
import {
  PythonFrameworkBridge,
  PythonFrameworkError,
  type PythonFrameworkTargetOptions,
  PythonFrameworkTimeoutError,
} from "./bridge.js";

interface Family {
  members: Set<PythonFrameworkTarget>;
  closed: boolean;
}

abstract class PythonFrameworkTarget extends AgentTarget {
  override readonly managesOwnTimeout = true;
  readonly timeoutMs: number;
  private readonly bridge: PythonFrameworkBridge;
  private family: Family;
  private ownsFamily = true;
  private closing?: Promise<void>;

  protected constructor(
    framework: "crewai" | "pydantic_ai",
    override readonly historyMode: "caller" | "target",
    options: PythonFrameworkTargetOptions,
    targetOptions: Record<string, unknown>,
  ) {
    super();
    const id = randomUUID().replaceAll("-", "");
    this.mintMemoryEntityId(id);
    this.bridge = new PythonFrameworkBridge(
      framework,
      options,
      targetOptions,
      id,
      historyMode,
    );
    this.timeoutMs = this.bridge.timeoutMs;
    this.family = { members: new Set([this]), closed: false };
  }

  protected adopt<T extends PythonFrameworkTarget>(target: T): T {
    if (this.closing || this.family.closed)
      throw new PythonFrameworkError("Python framework target is closed");
    target.family = this.family;
    target.ownsFamily = false;
    this.family.members.add(target);
    return target;
  }

  override async respond(
    messages: MessageInput[],
    options: { signal?: AbortSignal } = {},
  ): Promise<AgentResponse> {
    const wire = messages.map((message) =>
      toPythonKeys(MessageSchema.parse(message), "Message"),
    );
    return AgentResponse.fromJSON(
      await this.bridge.request("respond", { messages: wire }, options.signal),
    );
  }

  override async getAgentContext(): Promise<AgentContext> {
    const context = await this.bridge.request("get_agent_context", {});
    return AgentContextSchema.parse(fromPythonKeys(context, "AgentContext"));
  }

  override async cleanupMemory(
    _context: AgentContext,
    entityIds: string[],
  ): Promise<void> {
    const ids = new Set(entityIds);
    await Promise.all(
      [...this.family.members]
        .filter((target) => ids.has(target.memoryEntityId ?? ""))
        .map((target) => target.close()),
    );
  }

  override mapError(error: unknown): { code: string; message: string } | null {
    if (error instanceof PythonFrameworkTimeoutError)
      return { code: "timeout", message: error.message };
    if (error instanceof PythonFrameworkError)
      return { code: "python_framework_error", message: error.message };
    return null;
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      if (this.ownsFamily) this.family.closed = true;
      const members = this.ownsFamily ? [...this.family.members] : [this];
      await Promise.all(members.map((target) => target.bridge.close()));
      for (const target of members) this.family.members.delete(target);
    })();
    return this.closing;
  }
}

export interface CrewAITargetOptions extends PythonFrameworkTargetOptions {
  inputKey?: string;
  extraInputs?: Record<string, unknown>;
  agentContext?: AgentContext;
}

export class CrewAITarget extends PythonFrameworkTarget {
  constructor(readonly options: CrewAITargetOptions) {
    super("crewai", "caller", options, {
      ...(options.inputKey === undefined
        ? {}
        : { input_key: options.inputKey }),
      ...(options.extraInputs === undefined
        ? {}
        : { extra_inputs: options.extraInputs }),
      ...(options.agentContext === undefined
        ? {}
        : {
            agent_context: toPythonKeys(options.agentContext, "AgentContext"),
          }),
    });
  }

  override newInstance(): CrewAITarget {
    return this.adopt(new CrewAITarget(this.options));
  }
}

export interface PydanticAITargetOptions extends PythonFrameworkTargetOptions {
  runKwargs?: Record<string, unknown>;
  agentContext?: AgentContext;
}

export class PydanticAITarget extends PythonFrameworkTarget {
  constructor(readonly options: PydanticAITargetOptions) {
    super("pydantic_ai", "target", options, {
      ...(options.runKwargs === undefined
        ? {}
        : { run_kwargs: options.runKwargs }),
      ...(options.agentContext === undefined
        ? {}
        : {
            agent_context: toPythonKeys(options.agentContext, "AgentContext"),
          }),
    });
  }

  override newInstance(): PydanticAITarget {
    return this.adopt(new PydanticAITarget(this.options));
  }
}
