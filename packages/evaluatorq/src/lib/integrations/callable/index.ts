import {
  type AgentContext,
  AgentContextSchema,
  AgentResponse,
  AgentTarget,
  type Message,
  type Usage,
} from "../../contracts.js";

export type AgentCallable = (
  messages: Message[],
) =>
  | string
  | AgentResponse
  | null
  | undefined
  | PromiseLike<string | AgentResponse | null | undefined>;
export interface CallableTargetOptions {
  resetFn?: () => void;
  usageFn?: (messages: Message[], response: string) => Usage | null;
  agentContext?: AgentContext;
}
export class CallableTarget extends AgentTarget {
  constructor(
    readonly fn: AgentCallable,
    readonly options: CallableTargetOptions = {},
  ) {
    super();
  }
  override async respond(messages: Message[]): Promise<AgentResponse> {
    let result: Awaited<ReturnType<AgentCallable>>;
    try {
      result = await this.fn(messages);
    } catch (error) {
      if (
        error instanceof Error &&
        ["AbortError", "TimeoutError"].includes(error.name)
      )
        throw error;
      throw new Error(
        `CallableTarget: callable raised ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (result instanceof AgentResponse) return result;
    const text = result == null ? "" : String(result);
    let usage: Usage | null = null;
    if (this.options.usageFn) {
      try {
        usage = this.options.usageFn(messages, text);
      } catch (error) {
        console.warn("usageFn raised an exception; using usage=null", error);
      }
    }
    return new AgentResponse({ text, usage });
  }
  override async getAgentContext(): Promise<AgentContext> {
    return (
      this.options.agentContext ??
      AgentContextSchema.parse({
        key: this.fn.name || "callable_target",
        description: "opaque callable target",
      })
    );
  }
  override newInstance(): CallableTarget {
    this.options.resetFn?.();
    return new CallableTarget(this.fn, { ...this.options });
  }
}
