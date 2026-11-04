import { AsyncLocalStorage } from "node:async_hooks";

const conversations = new AsyncLocalStorage<object>();

/**
 * Runs a target call inside one conversation. A target shared by overlapping
 * rows can't hold this itself, so it travels with the async call instead.
 */
export function inConversation<T>(conversation: object, call: () => T): T {
  return conversations.run(conversation, call);
}

export function currentConversation(): object | undefined {
  return conversations.getStore();
}
