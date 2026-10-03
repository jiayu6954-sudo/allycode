import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DATA_DIR } from "../config/settings.js";
import type { ConversationMessage } from "../types/agent.js";
import type { ProviderTurnState } from "../providers/interface.js";

/** Private protocol state is never part of the visible transcript or export. */
export function externalizeContinuation(
  messages: ConversationMessage[],
  directory = path.join(DATA_DIR, "private-continuation"),
): ConversationMessage[] {
  return messages.map((message) => {
    if (!message.providerState) return message;
    const payload = JSON.stringify(message.providerState);
    const ref = createHash("sha256").update(payload).digest("hex");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const target = path.join(directory, `${ref}.json`);
    if (!fs.existsSync(target)) {
      const temp = `${target}.${randomUUID()}.tmp`;
      fs.writeFileSync(temp, payload, { mode: 0o600, flag: "wx" });
      fs.renameSync(temp, target);
    }
    const { providerState: _private, ...visible } = message;
    return { ...visible, providerStateRef: ref };
  });
}

export function hydrateContinuation(
  messages: ConversationMessage[],
  directory = path.join(DATA_DIR, "private-continuation"),
): ConversationMessage[] {
  return messages.map((message) => {
    if (message.providerState || !message.providerStateRef) return message;
    if (!/^[a-f0-9]{64}$/.test(message.providerStateRef)) throw new Error("Invalid continuation reference");
    try {
      const payload = fs.readFileSync(path.join(directory, `${message.providerStateRef}.json`), "utf8");
      if (createHash("sha256").update(payload).digest("hex") !== message.providerStateRef) throw new Error("hash mismatch");
      const state = JSON.parse(payload) as ProviderTurnState;
      if (state.protocol !== "deepseek-chat" && state.protocol !== "responses") throw new Error("unsupported state");
      return { ...message, providerState: state };
    } catch {
      // Missing state is rebased at the protocol boundary, never fabricated.
      return message;
    }
  });
}

export function visibleTranscript(messages: ConversationMessage[]): ConversationMessage[] {
  return messages.map(({ providerState: _state, providerStateRef: _ref, ...message }) => message);
}
