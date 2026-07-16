import type {
  AdapterCapabilities,
  IngestRouter,
  InboundAttachment,
  InboundMsg,
  ThreadRef,
  TransportAdapter,
} from "../types.js";

interface TelegramAdapterConfig {
  botToken: string;
  chatId: string; // forum-enabled supergroup id
  allowedUserIds?: (number | string)[];
}

/** One rendered size of a photo (Telegram sends an array from thumbnail to full resolution). */
export interface TgPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

/** A file sent as a document (e.g. an uncompressed image). */
export interface TgDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

/** A voice note (OGG/Opus) or an audio file (music). */
export interface TgAudio {
  file_id: string;
  file_unique_id?: string;
  mime_type?: string;
  file_size?: number;
  duration?: number;
  file_name?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    message_thread_id?: number;
    text?: string;
    caption?: string;
    photo?: TgPhotoSize[];
    document?: TgDocument;
    voice?: TgAudio;
    audio?: TgAudio;
    from?: { id: number };
    chat?: { id: number };
  };
}

/**
 * Extract image attachments from a Telegram message. Photos arrive as an array of sizes (pick the
 * largest); uncompressed images arrive as documents with an image/* mime type. The bytes are
 * resolved lazily via getFile (see fetchAttachment), so here we only carry the file_id as `ref`.
 */
export function collectTgAttachments(m: NonNullable<TgUpdate["message"]>): InboundAttachment[] {
  const out: InboundAttachment[] = [];
  if (Array.isArray(m.photo) && m.photo.length) {
    const largest = m.photo.reduce((a, b) => {
      const sa = a.file_size ?? a.width * a.height;
      const sb = b.file_size ?? b.width * b.height;
      return sb > sa ? b : a;
    });
    out.push({
      kind: "image",
      filename: `photo_${largest.file_unique_id}.jpg`,
      size: largest.file_size,
      ref: largest.file_id,
    });
  }
  if (m.document && (m.document.mime_type || "").toLowerCase().startsWith("image/")) {
    out.push({
      kind: "image",
      filename: m.document.file_name || `image_${m.document.file_id}.bin`,
      contentType: m.document.mime_type,
      size: m.document.file_size,
      ref: m.document.file_id,
    });
  }
  // Voice note (OGG/Opus) or an audio file — candidates for speech-to-text.
  const audio = m.voice || m.audio;
  if (audio) {
    const ext = (audio.mime_type || "").includes("mpeg") ? "mp3" : "oga";
    out.push({
      kind: "audio",
      filename: audio.file_name || `voice_${audio.file_unique_id || audio.file_id}.${ext}`,
      contentType: audio.mime_type || "audio/ogg",
      size: audio.file_size,
      durationSec: audio.duration,
      ref: audio.file_id,
    });
  }
  return out;
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
    if (!m) continue;
    if (m.message_thread_id == null) continue; // only threaded (per-session) messages
    const attachments = collectTgAttachments(m);
    // A photo/document message carries its text in `caption`; plain messages use `text`.
    const text = typeof m.text === "string" ? m.text : typeof m.caption === "string" ? m.caption : "";
    if (!text && attachments.length === 0) continue; // nothing usable (sticker, service msg, ...)
    const fromId = m.from?.id != null ? String(m.from.id) : "";
    if (allowed.size > 0 && !allowed.has(fromId)) continue; // whitelist enforcement
    routed.push({
      thread: String(m.message_thread_id),
      msg: {
        id: String(m.message_id),
        text,
        ts: m.date * 1000,
        authorId: fromId,
        ...(attachments.length ? { attachments } : {}),
      },
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

  /** Resolve a Telegram file_id to bytes: getFile -> file_path -> download from the file API. */
  async fetchAttachment(att: InboundAttachment): Promise<Buffer> {
    if (!att.ref) throw new Error("telegram attachment has no file ref");
    const file = await this.call("getFile", { file_id: att.ref });
    const filePath = file?.file_path;
    if (!filePath) throw new Error("telegram getFile returned no file_path");
    const url = `https://api.telegram.org/file/bot${this.cfg.botToken}/${filePath}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`telegram file download failed: HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
}
