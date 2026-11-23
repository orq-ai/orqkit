import { pythonStrip } from "../../common/sanitize.js";
import { NonRetryableTargetError } from "../../common/target-call.js";
import { LINE_BREAKS } from "../../common/unified-diff.js";
import {
  type AgentContext,
  AgentContextSchema,
  AgentResponse,
  AgentTarget,
  contentToText,
  extractUsage,
  type Message,
  type Usage,
} from "../../contracts.js";

export type AISdkMessageFormat = "v4" | "v5";
export interface AISdkHttpTargetOptions {
  headers?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  timeoutMs?: number;
  agentContext?: AgentContext;
  messageFormat?: AISdkMessageFormat;
}
export function messageToAISdkMessage(
  message: Message,
  version: AISdkMessageFormat = "v5",
): Record<string, unknown> {
  if (message.role === "tool") {
    const part: Record<string, unknown> = {
      type: "tool-result",
      toolCallId: message.tool_call_id || "",
      toolName: message.name || "",
    };
    const text = contentToText(message.content);
    if (version === "v4") part.result = text;
    else part.output = { type: "text", value: text };
    return { role: "tool", content: [part] };
  }
  if (message.role === "assistant" && message.tool_calls?.length) {
    const parts: Record<string, unknown>[] = [];
    if (message.content)
      parts.push({ type: "text", text: contentToText(message.content) });
    for (const call of message.tool_calls) {
      let input: unknown = call.function.arguments;
      try {
        input = JSON.parse(call.function.arguments);
      } catch {}
      parts.push({
        type: "tool-call",
        toolCallId: call.id,
        toolName: call.function.name,
        [version === "v4" ? "args" : "input"]: input,
      });
    }
    return { role: "assistant", content: parts };
  }
  return { role: message.role, content: contentToText(message.content) };
}
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const usageFrom = (value: unknown): Usage | null => {
  const usage = record(value) ? extractUsage(value, 1) : null;
  return usage && (usage.inputTokens > 0 || usage.outputTokens > 0)
    ? usage
    : null;
};
const messageContent = (value: unknown): string =>
  value === null
    ? "None"
    : value === true
      ? "True"
      : value === false
        ? "False"
        : typeof value === "object"
          ? JSON.stringify(value)
          : String(value);
export interface AISdkHttpResponse {
  text: string;
  usage: Usage | null;
}
export function parseAISdkDataStream(raw: string): AISdkHttpResponse {
  const parts: string[] = [];
  let usage: Usage | null = null;
  for (const line of raw.split(new RegExp(LINE_BREAKS))) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const prefix = line.slice(0, separator),
      payload = line.slice(separator + 1);
    if (prefix === "0") {
      let text: unknown;
      try {
        text = JSON.parse(payload);
      } catch {
        text = payload;
      }
      if (typeof text !== "string")
        throw new TypeError("AI SDK text chunk must be a string");
      parts.push(text);
    } else if (prefix === "e" || prefix === "d") {
      let frame: unknown;
      try {
        frame = JSON.parse(payload);
      } catch {
        continue;
      }
      usage = usageFrom(record(frame)?.usage) ?? usage;
    }
  }
  return { text: parts.join(""), usage };
}
export function parseAISdkJsonResponse(raw: string): AISdkHttpResponse {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { text: pythonStrip(raw), usage: null };
  }
  if (typeof data === "string") return { text: data, usage: null };
  const object = record(data);
  let usage: Usage | null = null;
  if (object) {
    usage = usageFrom(object.usage);
    const message = object.message;
    const messageObject = record(message);
    if (messageObject)
      return {
        text: messageContent(
          "content" in messageObject ? messageObject.content : "",
        ),
        usage,
      };
    if (typeof message === "string") return { text: message, usage };
    for (const key of ["text", "content", "response", "output"])
      if (typeof object[key] === "string")
        return { text: object[key] as string, usage };
    const choices = object.choices;
    if (Array.isArray(choices) && choices.length) {
      const message = record(record(choices[0])?.message ?? {});
      if (message)
        return {
          text: messageContent("content" in message ? message.content : ""),
          usage,
        };
    }
  }
  return { text: pythonStrip(raw), usage };
}
export function parseAISdkHttpResponse(
  raw: string,
  contentType: string,
): AISdkHttpResponse {
  if (
    raw.startsWith("0:") ||
    (contentType.includes("text/plain") && /^(?:0|e|d):/m.test(raw))
  )
    return parseAISdkDataStream(raw);
  if (contentType.includes("application/json"))
    return parseAISdkJsonResponse(raw);
  return { text: pythonStrip(raw), usage: null };
}
export class VercelAISdkTarget extends AgentTarget {
  override readonly managesOwnTimeout = true;
  readonly timeoutMs: number;
  constructor(
    readonly url: string,
    readonly options: AISdkHttpTargetOptions = {},
  ) {
    super();
    this.timeoutMs = options.timeoutMs ?? 120_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0)
      throw new RangeError("timeoutMs must be positive and finite");
    if (
      options.messageFormat !== undefined &&
      !["v4", "v5"].includes(options.messageFormat)
    )
      throw new RangeError("messageFormat must be v4 or v5");
  }
  get name(): string {
    return this.url;
  }
  override async respond(
    messages: Message[],
    options: { signal?: AbortSignal } = {},
  ): Promise<AgentResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.options.headers,
        },
        body: JSON.stringify({
          messages: messages.map((message) =>
            messageToAISdkMessage(message, this.options.messageFormat),
          ),
          ...this.options.extraBody,
        }),
        signal,
      });
      if (!response.ok)
        throw Object.assign(
          new Error(`HTTP ${response.status}: ${response.statusText}`),
          { status: response.status },
        );
      const parsed = parseAISdkHttpResponse(
        await response.text(),
        response.headers.get("content-type") ?? "",
      );
      return new AgentResponse({ text: parsed.text, usage: parsed.usage });
    } catch (error) {
      if (options.signal?.aborted)
        throw Object.assign(
          new Error("AI SDK HTTP request cancelled", {
            cause: options.signal.reason,
          }),
          { name: "AbortError" },
        );
      if (controller.signal.aborted)
        throw Object.assign(
          new NonRetryableTargetError(
            `AI SDK HTTP request timed out after ${this.timeoutMs} ms`,
            { cause: error },
          ),
          { name: "TimeoutError" },
        );
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  override async getAgentContext(): Promise<AgentContext> {
    if (this.options.agentContext) return this.options.agentContext;
    const parsed = new URL(this.url);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    const key = `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(
      /\/+$/,
      "",
    );
    return AgentContextSchema.parse({
      key,
      description: "opaque Vercel AI SDK HTTP target",
    });
  }
  override newInstance(): VercelAISdkTarget {
    return new VercelAISdkTarget(this.url, {
      ...this.options,
      headers: { ...this.options.headers },
      extraBody: { ...this.options.extraBody },
    });
  }
}
