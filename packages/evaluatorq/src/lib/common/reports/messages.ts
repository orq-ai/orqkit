import { contentToText, type MessageContent } from "../../contracts.js";
import { messagesToText } from "../messages.js";
import { esc } from "./html-helpers.js";

const KNOWN_ROLES = new Set(["user", "assistant", "system", "tool"]);

export function renderMessageList(
  messages: readonly Record<string, unknown>[],
  options: {
    roleLabels: Readonly<Record<string, string>>;
    classPrefix: string;
  },
): string {
  const { roleLabels, classPrefix: prefix } = options;
  return messages
    .map((message) => {
      const role = String(message.role ?? "unknown");
      const label = esc(roleLabels[role] ?? role);
      const raw = message.content;
      const calls = message.tool_calls;
      const text =
        Array.isArray(calls) && calls.length > 0
          ? messagesToText([message] as never)
          : raw === null || raw === undefined
            ? ""
            : contentToText(raw as MessageContent);
      const cssRole = KNOWN_ROLES.has(role) ? role : "unknown";
      return (
        `<div class="${prefix}-msg ${prefix}-msg-${esc(cssRole)}">` +
        `<span class="${prefix}-msg-avatar">${label}</span>` +
        `<div class="${prefix}-msg-bubble">` +
        `<span class="${prefix}-msg-role">${label}</span>` +
        `<pre class="${prefix}-msg-content">${esc(text)}</pre>` +
        "</div></div>"
      );
    })
    .join("");
}
