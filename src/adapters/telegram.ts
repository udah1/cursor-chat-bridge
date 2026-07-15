import type {
  AdapterCapabilities,
  IngestRouter,
  InboundMsg,
  ThreadRef,
  TransportAdapter,
} from "../types.js";

interface TelegramAdapterConfig {
  botToken: string;
  chatId: string; // forum-enabled supergroup id
  allowedUserIds?: (number | string)[];
}

export interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    message_thread_id?: number;
    text?: string;
    from?: { id: number };
    chat?: { id: number };
  };
}

/** Human-friendly workspace name (basename of the cwd path), for the topic intro. */
function workspaceName(cwd: unknown): string {
  const s = typeof cwd === "string" ? cwd.replace(/[/\\]+$/, "") : "";
  return s ? s.split(/[/\\]/).filter(Boolean).pop() || "" : "";
}

/**
 * Pure routing logic (exported for unit tests). Given a batch of updates and the
 * allow-list, returns messages to route (keyed by thread) and the next offset.
 */
export function routeUpdates(
  updates: TgUpdate[],
  allowed: Set<string>
): { routed: Array<{ thread: string; msg: InboundMsg }>; nextOffset: number | null } {
  let nextOffset: number | null = null;
  const routed: Array<{ thread: string; msg: InboundMsg }> = [];
  for (const u of updates) {
    nextOffset = u.update_id + 1;
    const m = u.message;
    if (!m || typeof m.text !== "string") continue;
    if (m.message_thread_id == null) continue; // only threaded (per-session) messages
    const fromId = m.from?.id != null ? String(m.from.id) : "";
    if (allowed.size > 0 && !allowed.has(fromId)) continue; // whitelist enforcement
    routed.push({
      thread: String(m.message_thread_id),
      msg: { id: String(m.message_id), text: m.text, ts: m.date * 1000, authorId: fromId },
    });
  }
  return { routed, nextOffset };
}

export class TelegramAdapter implements TransportAdapter {
  readonly name = "telegram";
  readonly capabilities: AdapterCapabilities = {
    globalIngest: true,
    separateBotIdentity: true, // the bot is a distinct identity from the user
  };

  private allowed: Set<string>;
  private polling = false;

  constructor(private cfg: TelegramAdapterConfig, private logFn: (m: string) => void) {
    this.allowed = new Set((cfg.allowedUserIds ?? []).map((x) => String(x)));
  }

  private base() {
    return `https://api.telegram.org/bot${this.cfg.botToken}`;
  }

  private async call(method: string, params: Record<string, unknown>): Promise<any> {
    const r = await fetch(`${this.base()}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    const j = (await r.json()) as { ok: boolean; result?: any; description?: string };
    if (!j.ok) throw new Error(`telegram ${method} failed: ${j.description}`);
    return j.result;
  }

  async init(): Promise<void> {
    if (!this.cfg.botToken) throw new Error("telegram adapter: botToken required");
    if (!this.cfg.chatId) throw new Error("telegram adapter: chatId (forum supergroup) required");
    await this.call("getMe", {});
  }

  async ensureThread(sessionId: string, title: string, meta?: Record<string, unknown>): Promise<ThreadRef> {
    const topic = await this.call("createForumTopic", {
      chat_id: this.cfg.chatId,
      name: title.slice(0, 128),
    });
    const threadId = Number(topic.message_thread_id);
    // Forum topics have no description field, so surface the workspace in a first message.
    const ws = workspaceName(meta?.cwd);
    if (ws) {
      await this.call("sendMessage", {
        chat_id: this.cfg.chatId,
        message_thread_id: threadId,
        text: `📁 *${ws}* — cursor-chat-bridge session`,
        parse_mode: "Markdown",
      }).catch(() => {});
    }
    return { adapter: this.name, thread: String(threadId), meta: { chatId: this.cfg.chatId } };
  }

  async send(thread: ThreadRef, text: string): Promise<{ messageId: string }> {
    const res = await this.call("sendMessage", {
      chat_id: this.cfg.chatId,
      message_thread_id: Number(thread.thread),
      text,
      parse_mode: "Markdown",
    });
    return { messageId: String(res.message_id) };
  }

  async startIngest(router: IngestRouter): Promise<() => void> {
    this.polling = true;
    let offset: number | undefined;
    const loop = async () => {
      while (this.polling) {
        try {
          const updates: TgUpdate[] = await this.call("getUpdates", {
            offset,
            timeout: 50,
            allowed_updates: ["message"],
          });
          const { routed, nextOffset } = routeUpdates(updates, this.allowed);
          if (nextOffset != null) offset = nextOffset;
          for (const { thread, msg } of routed) router(thread, msg);
        } catch (e: any) {
          this.logFn(`telegram ingest error: ${e?.message ?? e}`);
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    };
    void loop();
    return () => {
      this.polling = false;
    };
  }

  async stop(thread: ThreadRef): Promise<void> {
    await this.call("closeForumTopic", {
      chat_id: this.cfg.chatId,
      message_thread_id: Number(thread.thread),
    }).catch(() => {});
  }
}
