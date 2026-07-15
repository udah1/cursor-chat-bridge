import type { AdapterCapabilities, PollResult, ThreadRef, TransportAdapter } from "../types.js";

/**
 * Microsoft Teams adapter (Graph, delegated auth) — SCAFFOLD.
 *
 * Teams has no open bot on a locked corporate tenant, but the Microsoft Graph API
 * (graph.microsoft.com) is corporate-sanctioned and reachable. The intended design:
 *  - ensureThread: create/reuse a 1:1 "self" chat or a dedicated channel; a thread per session.
 *  - send: POST /chats/{id}/messages  (or /teams/{id}/channels/{id}/messages).
 *  - poll: GET messages since a timestamp; filter the agent's own messages by tracked ids.
 *
 * Blocked on: an Azure AD app registration with delegated Chat.ReadWrite / ChannelMessage.Send
 * and (usually) tenant admin consent, plus a device-code/refresh-token cache. Wire those in
 * `graphToken()` below and implement the three methods.
 */
interface TeamsAdapterConfig {
  clientId?: string;
  tenantId?: string;
  chatId?: string;
  tokenCommand?: string;
}

export class TeamsAdapter implements TransportAdapter {
  readonly name = "teams";
  readonly capabilities: AdapterCapabilities = { globalIngest: false, separateBotIdentity: false };

  constructor(private cfg: TeamsAdapterConfig, private logFn: (m: string) => void) {}

  private notReady(): never {
    throw new Error(
      "teams adapter is a scaffold: provide an Azure AD app (clientId/tenantId + delegated " +
        "Chat.ReadWrite) and implement graphToken()/ensureThread()/send()/poll(). See src/adapters/teams.ts."
    );
  }

  async init(): Promise<void> {
    this.notReady();
  }
  async ensureThread(): Promise<ThreadRef> {
    this.notReady();
  }
  async send(): Promise<{ messageId: string }> {
    this.notReady();
  }
  async poll(): Promise<PollResult> {
    this.notReady();
  }
}
