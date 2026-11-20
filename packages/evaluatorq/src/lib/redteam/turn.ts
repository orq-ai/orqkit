import { EMPTY_ASSISTANT_TEXT } from "../common/messages.js";
import {
  AgentResponse,
  type Message,
  MessageSchema,
  renderToolCall,
} from "../contracts.js";
export interface TurnInput {
  attacker: AgentResponse | Record<string, unknown>;
  target: AgentResponse | Record<string, unknown>;
}
export class Turn {
  readonly attacker: AgentResponse;
  readonly target: AgentResponse;
  constructor(input: TurnInput | Record<string, unknown>) {
    let attacker = input.attacker;
    if (
      attacker !== null &&
      typeof attacker === "object" &&
      !(attacker instanceof AgentResponse) &&
      !("output" in attacker) &&
      !("text" in attacker)
    ) {
      const legacy = attacker as Record<string, unknown>;
      if ("generatedPrompt" in legacy || "generated_prompt" in legacy) {
        attacker = {
          ...legacy,
          text: Object.hasOwn(legacy, "generatedPrompt")
            ? legacy.generatedPrompt
            : legacy.generated_prompt,
        };
        delete (attacker as Record<string, unknown>).truncated;
      }
    }
    this.attacker = AgentResponse.fromJSON(attacker);
    this.target = AgentResponse.fromJSON(input.target);
    Object.freeze(this);
  }
  get errored(): boolean {
    return this.target.error !== null;
  }
  toJSON(): Record<string, unknown> {
    return { attacker: { ...this.attacker }, target: { ...this.target } };
  }
}
export function turnsToMessages(
  turns: readonly Turn[],
  options: { skipErrors?: boolean } = {},
): Message[] {
  const out: Message[] = [];
  for (const turn of turns) {
    if (options.skipErrors && turn.errored) continue;
    out.push(
      MessageSchema.parse({ role: "user", content: turn.attacker.text }),
    );
    const text: string[] = [];
    const flush = () => {
      if (text.length) {
        out.push(
          MessageSchema.parse({ role: "assistant", content: text.join("") }),
        );
        text.length = 0;
      }
    };
    for (const item of turn.target.output) {
      if (item.type === "output_text") text.push(item.text);
      else if (item.type === "function_call") {
        flush();
        const { toolCall, toolMessage } = renderToolCall(item);
        out.push(
          MessageSchema.parse({
            role: "assistant",
            content: null,
            tool_calls: [toolCall],
          }),
        );
        if (toolMessage) out.push(toolMessage);
      }
    }
    flush();
    if (out.at(-1)?.role === "user")
      out.push(
        MessageSchema.parse({
          role: "assistant",
          content: EMPTY_ASSISTANT_TEXT,
        }),
      );
  }
  return out;
}
