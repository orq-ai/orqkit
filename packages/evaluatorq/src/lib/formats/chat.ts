import {
  type Message,
  type MessageInput,
  MessageSchema,
} from "../contracts.js";
import { chatToResponses } from "./convert-chat-responses.js";
import type { AtifConversionOptions } from "./convert-responses-atif.js";

export class ChatConversation {
  readonly messages: Message[];
  constructor(input: { messages: MessageInput[] }) {
    if (!input || !Array.isArray(input.messages))
      throw new TypeError("Chat messages must be an array");
    this.messages = input.messages.map((message) =>
      MessageSchema.parse(message),
    );
    Object.freeze(this);
  }
  toOtel(options: Omit<AtifConversionOptions, "sessionId"> = {}) {
    return this.toAtif(options).toOtel();
  }
  toAtif(options: AtifConversionOptions = {}) {
    return this.toResponses().toAtif(options);
  }
  toResponses() {
    return chatToResponses(this);
  }
}
