import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CONFIG_PATH, DAEMON_FILE, MEDIA_DIR, ensureRuntimeDir } from "./paths.js";
import { loadConfig, type BridgeConfig } from "./config.js";
import { Store } from "./state.js";
import { createAdapter } from "./adapters/index.js";
import type { InboundAttachment, InboundMsg, ThreadRef, TransportAdapter } from "./types.js";
import { log } from "./logger.js";
import { pushNotify } from "./notify.js";
import { createSttProvider, sanitizeSttError, withTimeout, type SttConfig, type SttProvider } from "./stt.js";

/** Drop bracketed audio/voice notes so they aren't duplicated when we build the transcript message. */
export function stripAudioNotes(text: string): string {
  return text
    .split("\n")
    .filter((l) => !/^\[(audio|voice)\b.*\]$/.test(l.trim()))
    .join("\n")
    .trim();
}

const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);

export const DAEMON_VERSION = "0.1.0";
const STOP_KEYWORDS = ["stop", "/stop", "עצור", "עצרי", "עצור."];

export function isStop(text: string): boolean {
  return STOP_KEYWORDS.includes(text.trim().toLowerCase()) || STOP_KEYWORDS.includes(text.trim());
}

/** Deep-link for a notification tap, when the adapter exposes enough metadata (GitHub issue). */
function threadUrl(thread: ThreadRef | null): string | undefined {
  if (!thread) return undefined;
  const owner = (thread.meta as any)?.owner;
  const repo = (thread.meta as any)?.repo;
  if (thread.adapter === "github" && owner && repo) {
    return `https://github.com/${owner}/${repo}/issues/${thread.thread}`;
  }
  return undefined;
}

export class Daemon {
  private cfg: BridgeConfig;
  private store = new Store();
  private adapters = new Map<string, TransportAdapter>();
  private ingestStoppers = new Map<string, () => void>();
  private threadToSession = new Map<string, string>();
  private token = crypto.randomBytes(24).toString("hex");
  private server?: http.Server;
  private sttProvider: SttProvider | null = null;
  private sttResolved = false;
  private sttInFlight = new Set<string>();
  private cfgMtimeMs = 0;

  constructor() {
    this.cfg = loadConfig();
    this.cfgMtimeMs = this.configMtime();
  }

  private configMtime(): number {
    try {
      return fs.statSync(CONFIG_PATH).mtimeMs;
    } catch {
      return 0;
    }
  }

  /**
   * Hot-reload config.json when it changes on disk, so edits (poll interval, STT
   * provider/keys, timeouts) take effect without restarting the daemon. Adapter
   * credential changes still need a restart since ingest streams are set up once.
   */
  private reloadConfigIfChanged(): void {
    const m = this.configMtime();
    if (m === 0 || m === this.cfgMtimeMs) return;
    try {
      this.cfg = loadConfig();
      this.cfgMtimeMs = m;
      // Force STT to re-resolve against the new config on next use.
      this.sttResolved = false;
      this.sttProvider = null;
      log(
        `config reloaded: pollIntervalMs=${this.cfg.pollIntervalMs} stt.enabled=${this.cfg.stt?.enabled} stt.provider=${this.cfg.stt?.provider}`,
      );
    } catch (e) {
      log(`config reload failed, keeping previous: ${(e as Error).message}`);
    }
  }

  /** Resolve the STT provider once (keys resolved here, not per request). */
  private getStt(): { provider: SttProvider | null; cfg: SttConfig | undefined } {
    if (!this.sttResolved) {
      this.sttProvider = createSttProvider(this.cfg.stt);
      this.sttResolved = true;
      if (this.cfg.stt?.enabled) {
        if (this.cfg.stt.provider === "openai") log("stt: cloud provider active — audio will be sent off-host");
        else log(`stt: local provider active (${this.cfg.stt.localBin})`);
        if (!this.sttProvider) log("stt: enabled but provider unusable (missing API key / config)");
      }
    }
    return { provider: this.sttProvider, cfg: this.cfg.stt };
  }

  private async getAdapter(name: string): Promise<TransportAdapter> {
    let a = this.adapters.get(name);
    if (!a) {
      a = createAdapter(name, this.cfg, log);
      await a.init();
      this.adapters.set(name, a);
      // Global-ingest adapters (Telegram) get one shared routing loop.
      if (a.capabilities.globalIngest && a.startIngest) {
        const stop = await a.startIngest((thread, msg) => this.routeIngest(name, thread, msg));
        this.ingestStoppers.set(name, stop);
        log(`started global ingest for adapter ${name}`);
      }
    }
    return a;
  }

  private routeIngest(adapter: string, thread: string, msg: InboundMsg): void {
    const sessionId = this.threadToSession.get(`${adapter}:${thread}`);
    if (!sessionId) return;
    this.store.enqueueInbound(sessionId, msg);
  }

  async start(): Promise<{ port: number; token: string }> {
    ensureRuntimeDir();
    // Rebuild thread->session routing from persisted state.
    for (const s of this.store.all()) {
      if (s.thread) this.threadToSession.set(`${s.adapter}:${s.thread.thread}`, s.id);
    }
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const port = (this.server!.address() as any).port as number;
    fs.writeFileSync(
      DAEMON_FILE,
      JSON.stringify({ pid: process.pid, port, token: this.token, version: DAEMON_VERSION, startedAt: Date.now() }, null, 2),
      { mode: 0o600 }
    );
    log(`daemon listening on 127.0.0.1:${port} (pid ${process.pid})`);
    return { port, token: this.token };
  }

  private send(res: http.ServerResponse, code: number, body: unknown): void {
    const s = JSON.stringify(body);
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(s);
  }

  private async readBody(req: http.IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (!chunks.length) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return {};
    }
  }

  private authed(req: http.IncomingMessage): boolean {
    return req.headers["x-bridge-token"] === this.token;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      // /health is unauthenticated (liveness only).
      if (url.pathname === "/health") {
        return this.send(res, 200, { ok: true, version: DAEMON_VERSION, pid: process.pid });
      }
      if (!this.authed(req)) return this.send(res, 401, { error: "unauthorized" });

      if (url.pathname === "/register" && req.method === "POST") return await this.register(req, res);
      if (url.pathname === "/send" && req.method === "POST") return await this.sendMsg(req, res);
      if (url.pathname === "/poll" && req.method === "GET") return await this.poll(url, res);
      if (url.pathname === "/stop" && req.method === "POST") return await this.stop(req, res);
      if (url.pathname === "/status" && req.method === "GET") return this.status(url, res);
      if (url.pathname === "/shutdown" && req.method === "POST") {
        this.send(res, 200, { ok: true });
        return this.shutdown();
      }
      return this.send(res, 404, { error: "not found" });
    } catch (e: any) {
      log(`handler error: ${e?.stack ?? e}`);
      return this.send(res, 500, { error: String(e?.message ?? e) });
    }
  }

  private async register(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const { sessionId, title, cwd } = body;
    const adapterName = body.adapter || this.cfg.activeAdapter;
    if (!sessionId || !title) return this.send(res, 400, { error: "sessionId and title required" });
    const adapter = await this.getAdapter(adapterName);

    let rec = this.store.get(sessionId);
    if (rec && rec.thread && rec.adapter === adapterName && rec.active && !rec.stopRequested) {
      // Re-register of a still-live session (e.g. after a daemon restart): keep the thread.
      rec = this.store.upsert(sessionId, {
        title,
        cwd: cwd ?? rec.cwd,
        adapter: adapterName,
        active: true,
        stopRequested: false,
        thread: rec.thread,
      });
    } else {
      // New session, or re-activation of a previously stopped one -> fresh thread and clean stop state.
      const thread = await adapter.ensureThread(sessionId, title, { cwd });
      rec = this.store.upsert(sessionId, {
        title,
        cwd: cwd ?? "",
        adapter: adapterName,
        thread,
        active: true,
        stopRequested: false,
      });
      this.threadToSession.set(`${adapterName}:${thread.thread}`, sessionId);
    }
    return this.send(res, 200, { ok: true, thread: rec.thread, generation: rec.generation, adapter: adapterName });
  }

  private async sendMsg(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const { sessionId, text } = body;
    const rec = this.store.get(sessionId);
    if (!rec || !rec.thread) return this.send(res, 404, { error: "unknown session" });
    const adapter = await this.getAdapter(rec.adapter);
    const { messageId } = await adapter.send(rec.thread, text);
    this.store.recordOwnMessage(sessionId, messageId);
    // Fire an out-of-band push (best-effort) so the user gets a phone alert. Include the
    // thread id so conversations sharing a workspace title are still distinguishable.
    // Skip for channels that already push natively (Telegram, Discord) to avoid double-buzzing —
    // ntfy exists mainly because GitHub never notifies you about your own comments.
    if (rec.adapter !== "telegram" && rec.adapter !== "discord") {
      const notifyTitle = rec.thread ? `${rec.title} #${rec.thread.thread}` : rec.title;
      pushNotify(
        this.cfg.notify,
        { title: notifyTitle, message: text, clickUrl: threadUrl(rec.thread) },
        log
      ).catch(() => {});
    }
    return this.send(res, 200, { ok: true, messageId });
  }

  private async poll(url: URL, res: http.ServerResponse): Promise<void> {
    // Pick up config edits (poll interval, STT provider/keys) without a daemon restart.
    this.reloadConfigIfChanged();
    const sessionId = url.searchParams.get("sessionId") ?? "";
    const waitMs = Math.min(Number(url.searchParams.get("waitMs") ?? "0"), 55000);
    const rec = this.store.get(sessionId);
    if (!rec || !rec.thread) return this.send(res, 404, { error: "unknown session" });
    const adapter = await this.getAdapter(rec.adapter);
    const startGen = rec.generation;
    const deadline = Date.now() + waitMs;
    // loadConfig() already applies the floor; honor the configured value here.
    const interval = this.cfg.pollIntervalMs;

    do {
      // Stop requested out-of-band?
      if (rec.stopRequested || rec.generation !== startGen) {
        return this.send(res, 200, { messages: [], stopped: true, generation: rec.generation });
      }

      let messages: InboundMsg[] = [];
      let stopped = false;

      if (adapter.capabilities.globalIngest) {
        // Inbox holds both Telegram arrivals AND out-of-band injections (async STT transcripts).
        messages = this.store.drainInbox(sessionId);
      } else if (adapter.poll) {
        const r = await adapter.poll(rec.thread, rec.cursor);
        this.store.setCursor(sessionId, r.cursor);
        stopped = r.stopped;
        messages = r.messages.filter((m) => !this.store.isOwnMessage(sessionId, m.id));
        // Also pick up messages injected out-of-band (e.g. async STT transcripts).
        messages = messages.concat(this.store.drainInbox(sessionId));
      }

      // Download any media attachments to disk and surface their local paths to the agent.
      if (messages.length > 0) await this.materializeAttachments(sessionId, adapter, messages);

      // Route audio through async speech-to-text: suppress the raw audio message now; the
      // transcript is injected as a new inbound message and delivered by a later poll iteration.
      if (messages.length > 0) messages = this.routeSttMessages(sessionId, messages);

      // A stop keyword in any user message ends the session.
      if (messages.some((m) => isStop(m.text))) stopped = true;

      if (stopped) {
        this.store.requestStop(sessionId);
        return this.send(res, 200, { messages, stopped: true, generation: rec.generation });
      }
      if (messages.length > 0) {
        return this.send(res, 200, { messages, stopped: false, generation: rec.generation });
      }
      if (Date.now() >= deadline) {
        return this.send(res, 200, { messages: [], stopped: false, generation: rec.generation });
      }
      await new Promise((r) => setTimeout(r, Math.min(interval, Math.max(0, deadline - Date.now()))));
    } while (true);
  }

  /**
   * Download each message's attachments to `MEDIA_DIR/<session>/` and append a note to the message
   * text pointing at the saved file, so the agent (which only ever receives text) can open the
   * image with its Read tool. Best-effort: a failed download degrades to an inline note.
   */
  private async materializeAttachments(
    sessionId: string,
    adapter: TransportAdapter,
    messages: InboundMsg[]
  ): Promise<void> {
    if (!adapter.fetchAttachment) return;
    const sttOn = !!this.cfg.stt?.enabled;
    for (const m of messages) {
      if (!m.attachments || m.attachments.length === 0) continue;
      const notes: string[] = [];
      for (const att of m.attachments) {
        try {
          const buf = await adapter.fetchAttachment(att);
          const dir = path.join(MEDIA_DIR, sessionId);
          fs.mkdirSync(dir, { recursive: true });
          const safe = (att.filename || att.kind).replace(/[^A-Za-z0-9._-]/g, "_").slice(-80) || att.kind;
          const file = path.join(dir, `${m.id}-${safe}`);
          fs.writeFileSync(file, buf);
          att.localPath = file;
          log(`saved ${att.kind} attachment for session ${sessionId}: ${file} (${buf.length} bytes)`);
          // Audio handled by the STT path (it injects a transcript) — don't add a note here.
          if (att.kind === "audio" && sttOn) continue;
          notes.push(
            att.kind === "image"
              ? `[image attachment "${att.filename}" received — saved locally; open it with the Read tool at: ${file}]`
              : `[${att.kind} attachment "${att.filename}" received — saved locally at: ${file}]`
          );
        } catch (e: any) {
          notes.push(`[${att.kind} attachment "${att.filename}" could not be downloaded: ${e?.message ?? e}]`);
          log(`attachment download failed for session ${sessionId}: ${e?.message ?? e}`);
        }
      }
      if (notes.length) m.text = m.text ? `${m.text}\n\n${notes.join("\n")}` : notes.join("\n");
    }
  }

  /**
   * Suppress messages carrying audio (so the agent never sees a raw, unreadable audio message) and
   * kick off a background transcription per audio message. When done, the transcript is injected via
   * `store.enqueueInbound` and delivered by a subsequent poll. Deduped by source message id.
   */
  private routeSttMessages(sessionId: string, messages: InboundMsg[]): InboundMsg[] {
    const { provider, cfg } = this.getStt();
    if (!cfg?.enabled) return messages;
    const out: InboundMsg[] = [];
    for (const m of messages) {
      const audio = (m.attachments ?? []).filter((a) => a.kind === "audio" && a.localPath);
      if (audio.length === 0) {
        out.push(m);
        continue;
      }
      if (!this.sttInFlight.has(m.id)) {
        this.sttInFlight.add(m.id);
        void this.transcribeAndInject(sessionId, m, audio[0], provider, cfg);
      }
      // suppress the raw audio message from immediate delivery
    }
    return out;
  }

  private async transcribeAndInject(
    sessionId: string,
    m: InboundMsg,
    att: InboundAttachment,
    provider: SttProvider | null,
    cfg: SttConfig
  ): Promise<void> {
    let note: string;
    try {
      if (!provider) {
        note = "[voice message received but speech-to-text is not usable — check stt.provider / API key]";
      } else if (att.size && att.size > cfg.maxBytes) {
        note = `[voice message too large to transcribe (${mb(att.size)}MB > ${mb(cfg.maxBytes)}MB limit)]`;
      } else {
        const res = await withTimeout(
          provider.transcribe(att.localPath!, { language: cfg.language, model: cfg.model }),
          cfg.timeoutMs,
          "stt"
        );
        const t = (res.text || "").trim();
        const lang = res.language ? ` (${res.language})` : "";
        note = t ? `[voice transcript${lang}]: ${t}` : "[voice message received but the transcription was empty]";
        if (t && !cfg.keepAudio) {
          try {
            fs.rmSync(att.localPath!, { force: true });
          } catch {}
        }
      }
    } catch (e) {
      note = `[voice message transcription failed: ${sanitizeSttError(e)}]`;
    }
    const base = stripAudioNotes(m.text);
    const text = base ? `${base}\n\n${note}` : note;
    // A transcribed "stop" must NOT auto-end the session; the bracketed prefix ensures isStop() misses.
    this.store.enqueueInbound(sessionId, { id: `stt-${m.id}`, text, ts: Date.now(), authorId: m.authorId });
    this.sttInFlight.delete(m.id);
    log(`stt: injected transcript for session ${sessionId} (src msg ${m.id})`);
  }

  private async stop(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const { sessionId, closeThread } = body;
    const rec = this.store.get(sessionId);
    if (!rec) return this.send(res, 404, { error: "unknown session" });
    this.store.requestStop(sessionId);
    if (closeThread && rec.thread) {
      const adapter = await this.getAdapter(rec.adapter).catch(() => null);
      if (adapter?.stop) await adapter.stop(rec.thread).catch(() => {});
    }
    return this.send(res, 200, { ok: true });
  }

  private status(url: URL, res: http.ServerResponse): void {
    const sessionId = url.searchParams.get("sessionId");
    if (sessionId) {
      const rec = this.store.get(sessionId);
      return this.send(res, 200, { session: rec ?? null });
    }
    return this.send(res, 200, {
      version: DAEMON_VERSION,
      activeAdapter: this.cfg.activeAdapter,
      sessions: this.store.all().map((s) => ({ id: s.id, title: s.title, adapter: s.adapter, active: s.active, thread: s.thread?.thread })),
    });
  }

  private shutdown(): void {
    for (const stop of this.ingestStoppers.values()) stop();
    try {
      fs.rmSync(DAEMON_FILE, { force: true });
    } catch {}
    this.server?.close();
    setTimeout(() => process.exit(0), 100);
  }
}
