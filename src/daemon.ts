import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import { DAEMON_FILE, ensureRuntimeDir } from "./paths.js";
import { loadConfig, type BridgeConfig } from "./config.js";
import { Store } from "./state.js";
import { createAdapter } from "./adapters/index.js";
import type { InboundMsg, ThreadRef, TransportAdapter } from "./types.js";
import { log } from "./logger.js";
import { pushNotify } from "./notify.js";

export const DAEMON_VERSION = "0.1.0";
const STOP_KEYWORDS = ["stop", "/stop", "עצור", "עצרי", "עצור."];

function isStop(text: string): boolean {
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

  constructor() {
    this.cfg = loadConfig();
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
    // Skip for channels that already push natively (Telegram) to avoid double-buzzing —
    // ntfy exists mainly because GitHub never notifies you about your own comments.
    if (rec.adapter !== "telegram") {
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
    const sessionId = url.searchParams.get("sessionId") ?? "";
    const waitMs = Math.min(Number(url.searchParams.get("waitMs") ?? "0"), 55000);
    const rec = this.store.get(sessionId);
    if (!rec || !rec.thread) return this.send(res, 404, { error: "unknown session" });
    const adapter = await this.getAdapter(rec.adapter);
    const startGen = rec.generation;
    const deadline = Date.now() + waitMs;
    const interval = Math.max(this.cfg.pollIntervalMs, this.cfg.minPollIntervalMs, 10000);

    do {
      // Stop requested out-of-band?
      if (rec.stopRequested || rec.generation !== startGen) {
        return this.send(res, 200, { messages: [], stopped: true, generation: rec.generation });
      }

      let messages: InboundMsg[] = [];
      let stopped = false;

      if (adapter.capabilities.globalIngest) {
        messages = this.store.drainInbox(sessionId);
      } else if (adapter.poll) {
        const r = await adapter.poll(rec.thread, rec.cursor);
        this.store.setCursor(sessionId, r.cursor);
        stopped = r.stopped;
        messages = r.messages.filter((m) => !this.store.isOwnMessage(sessionId, m.id));
      }

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
