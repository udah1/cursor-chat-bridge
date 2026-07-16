import { resolveSecret } from "../config.js";
import type {
  AdapterCapabilities,
  InboundAttachment,
  InboundMsg,
  PollResult,
  ThreadRef,
  TransportAdapter,
} from "../types.js";

const API = "https://discord.com/api/v10";
const MAX_CONTENT = 2000; // Discord hard limit per message.

/**
 * TLS-intercepting corporate proxies (e.g. Amdocs/Zscaler) block `cdn.discordapp.com` but allow
 * `media.discordapp.net` — the same bytes served from a different Discord edge. Rewriting the host
 * lets attachment downloads succeed behind such proxies (and is harmless off-network).
 */
export function toMediaHost(url: string): string {
  return url.replace("https://cdn.discordapp.com/", "https://media.discordapp.net/");
}

const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "heif", "avif"];
const AUDIO_EXTS = ["mp3", "ogg", "oga", "wav", "m4a", "opus", "aac", "flac"];
const VIDEO_EXTS = ["mp4", "mov", "webm", "mkv", "m4v"];

/** Classify an attachment by MIME type, falling back to the filename extension. */
export function attachmentKind(contentType?: string, filename?: string): InboundAttachment["kind"] {
  const t = (contentType || "").toLowerCase();
  if (t.startsWith("image/")) return "image";
  if (t.startsWith("audio/")) return "audio";
  if (t.startsWith("video/")) return "video";
  const ext = (filename || "").toLowerCase().split(".").pop() || "";
  if (IMAGE_EXTS.includes(ext)) return "image";
  if (AUDIO_EXTS.includes(ext)) return "audio";
  if (VIDEO_EXTS.includes(ext)) return "video";
  return "file";
}

/** Human-friendly workspace name (basename of the cwd path), for channel descriptions. */
function workspaceName(cwd: unknown): string {
  const s = typeof cwd === "string" ? cwd.replace(/[/\\]+$/, "") : "";
  return s ? s.split(/[/\\]/).filter(Boolean).pop() || "" : "";
}

interface DiscordAdapterConfig {
  /** Bot token from the Discord Developer Portal (NOT the "client secret"). */
  botToken?: string;
  /** Resolve the bot token via a shell command instead of storing it inline. */
  botTokenCommand?: string;
  /**
   * Anchor channel id. Used to discover the server (guild) and category under which a fresh
   * channel is created for each session. Any existing text channel in the target server works.
   */
  channelId: string;
  /** Optional whitelist of Discord user ids allowed to steer the agent. */
  allowedUserIds?: (number | string)[];
}

/** Raw Discord attachment shape (subset we consume). */
export interface DiscordAttachment {
  id: string;
  filename: string;
  content_type?: string;
  size?: number;
  url: string;
  width?: number;
  height?: number;
}

/** Raw Discord message shape (subset we consume). */
export interface DiscordMessage {
  id: string;
  content: string;
  timestamp: string;
  author: { id: string; bot?: boolean };
  attachments?: DiscordAttachment[];
}

/**
 * Pure routing/filtering logic (exported for unit tests). Given a batch of raw messages and the
 * filtering inputs, returns the user messages to route and the advanced cursor (max snowflake).
 * Drops bot/own posts and enforces the allow-list. On the first poll (cursor === null) it only
 * establishes a baseline (no messages) so we don't replay the intro / channel history.
 */
export function filterMessages(
  raw: DiscordMessage[],
  cursor: string | null,
  botUserId: string,
  allowed: Set<string>
): { messages: InboundMsg[]; cursor: string | null } {
  let maxId = cursor ? BigInt(cursor) : 0n;
  const messages: InboundMsg[] = [];
  for (const m of raw) {
    const idB = BigInt(m.id);
    if (idB > maxId) maxId = idB;
    if (m.author?.bot || String(m.author?.id) === botUserId) continue; // ignore bot/own posts
    if (allowed.size > 0 && !allowed.has(String(m.author.id))) continue; // whitelist
    const attachments: InboundAttachment[] = (m.attachments ?? []).map((a) => ({
      kind: attachmentKind(a.content_type, a.filename),
      filename: a.filename,
      contentType: a.content_type,
      size: a.size,
      // Rewrite to the proxy-friendly host so downloads work behind corporate TLS proxies.
      url: toMediaHost(a.url),
    }));
    messages.push({
      id: m.id,
      text: m.content,
      ts: Date.parse(m.timestamp),
      authorId: String(m.author.id),
      ...(attachments.length ? { attachments } : {}),
    });
  }
  const newCursor = maxId > 0n ? String(maxId) : cursor;
  if (!cursor) return { messages: [], cursor: newCursor };
  return { messages, cursor: newCursor };
}

/** Split a long body into Discord-sized chunks without cutting mid-line where avoidable. */
function chunk(text: string, size = MAX_CONTENT): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size * 0.5) cut = size; // no good newline near the boundary -> hard cut
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length) out.push(rest);
  return out;
}

/**
 * Discord transport. Uses the REST API with per-thread polling (like the GitHub adapter),
 * so it tunnels cleanly through TLS-intercepting corporate proxies — no gateway WebSocket
 * required. A session maps to a public thread under a parent channel; the user replies in
 * the thread and the agent posts turn summaries there.
 */
export class DiscordAdapter implements TransportAdapter {
  readonly name = "discord";
  readonly capabilities: AdapterCapabilities = {
    globalIngest: false,
    // The bot is a distinct identity; we drop bot-authored messages in poll() below.
    separateBotIdentity: true,
  };

  private token = "";
  private botUserId = "";
  private guildId = "";
  private parentId: string | null = null; // category to nest session channels under, if any
  private allowed: Set<string>;

  constructor(private cfg: DiscordAdapterConfig, private logFn: (m: string) => void) {
    this.allowed = new Set((cfg.allowedUserIds ?? []).map((x) => String(x)));
  }

  private async api(pathname: string, init?: RequestInit): Promise<Response> {
    return fetch(`${API}${pathname}`, {
      ...init,
      headers: {
        Authorization: `Bot ${this.token}`,
        "Content-Type": "application/json",
        "User-Agent": "cursor-chat-bridge (https://github.com/udah1/cursor-chat-bridge, 0.1)",
        ...(init?.headers ?? {}),
      },
    });
  }

  async init(): Promise<void> {
    if (!this.cfg.channelId) {
      throw new Error("discord adapter: 'channelId' (a text channel for per-session threads) is required");
    }
    this.token = resolveSecret(this.cfg.botToken, this.cfg.botTokenCommand);
    if (!this.token) {
      throw new Error("discord adapter: no bot token (set adapters.discord.botToken or botTokenCommand)");
    }
    // Validate the token and remember the bot's own user id.
    const me = await this.api("/users/@me");
    if (!me.ok) throw new Error(`discord adapter: invalid bot token (HTTP ${me.status})`);
    this.botUserId = String(((await me.json()) as { id: string }).id);
    // Validate channel access and discover the server (guild) + category from the anchor channel.
    const ch = await this.api(`/channels/${this.cfg.channelId}`);
    if (!ch.ok) {
      throw new Error(
        `discord adapter: cannot access channel ${this.cfg.channelId} (HTTP ${ch.status}). ` +
          "Make sure the bot is in the server and has View Channel + Manage Channels."
      );
    }
    const anchor = (await ch.json()) as { guild_id?: string; parent_id?: string | null };
    if (!anchor.guild_id) {
      throw new Error(`discord adapter: channel ${this.cfg.channelId} is not a server channel (no guild)`);
    }
    this.guildId = String(anchor.guild_id);
    this.parentId = anchor.parent_id ?? null;
  }

  async ensureThread(sessionId: string, title: string, meta?: Record<string, unknown>): Promise<ThreadRef> {
    // Create a dedicated channel per session in the server (Discord slugifies the name).
    const ws = workspaceName(meta?.cwd);
    const topic = (ws ? `📁 ${ws} · ` : "") + `cursor-chat-bridge session ${sessionId}`;
    const body: Record<string, unknown> = {
      name: title.slice(0, 100),
      type: 0, // GUILD_TEXT
      topic: topic.slice(0, 1024), // shown as the channel description
    };
    if (this.parentId) body.parent_id = this.parentId; // group under the anchor's category
    const r = await this.api(`/guilds/${this.guildId}/channels`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const detail = await r.text();
      const hint =
        r.status === 403
          ? " — the bot needs the 'Manage Channels' permission in this server."
          : "";
      throw new Error(`discord ensureThread failed: HTTP ${r.status} ${detail}${hint}`);
    }
    const chan = (await r.json()) as { id: string };
    // Post a short intro so the channel isn't empty.
    const intro =
      `**cursor-chat-bridge session** \`${sessionId}\`\n` +
      (meta?.cwd ? `📁 \`${meta.cwd}\`\n` : "") +
      "Reply here to steer the agent. Send `stop` to end the session.";
    await this.api(`/channels/${chan.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: intro.slice(0, MAX_CONTENT) }),
    }).catch(() => {});
    return { adapter: this.name, thread: String(chan.id), meta: { guildId: this.guildId } };
  }

  async send(thread: ThreadRef, text: string): Promise<{ messageId: string }> {
    let lastId = "";
    for (const part of chunk(text)) {
      const r = await this.api(`/channels/${thread.thread}/messages`, {
        method: "POST",
        body: JSON.stringify({ content: part }),
      });
      if (!r.ok) throw new Error(`discord send failed: HTTP ${r.status} ${await r.text()}`);
      lastId = String(((await r.json()) as { id: string }).id);
    }
    return { messageId: lastId };
  }

  async poll(thread: ThreadRef, cursor: string | null): Promise<PollResult> {
    // Discord snowflakes are time-ordered; `after` returns only newer messages.
    const qs = cursor ? `?limit=100&after=${cursor}` : `?limit=100`;
    const r = await this.api(`/channels/${thread.thread}/messages${qs}`);
    if (!r.ok) throw new Error(`discord poll failed: HTTP ${r.status} ${await r.text()}`);
    const raw = (await r.json()) as DiscordMessage[];
    const { messages, cursor: newCursor } = filterMessages(raw, cursor, this.botUserId, this.allowed);
    return { messages, cursor: newCursor, stopped: false };
  }

  async stop(thread: ThreadRef): Promise<void> {
    // End of session -> delete the per-session channel to keep the server tidy (best-effort).
    await this.api(`/channels/${thread.thread}`, { method: "DELETE" }).catch(() => {});
  }

  /** Download attachment bytes. Discord CDN URLs are pre-signed, so no auth header is needed. */
  async fetchAttachment(att: InboundAttachment): Promise<Buffer> {
    if (!att.url) throw new Error("discord attachment has no url");
    const r = await fetch(toMediaHost(att.url));
    if (!r.ok) throw new Error(`discord attachment download failed: HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
}
