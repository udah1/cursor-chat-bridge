import fs from "node:fs";
import { STATE_PATH, ensureRuntimeDir } from "./paths.js";
import type { InboundMsg, ThreadRef } from "./types.js";

export interface SessionRecord {
  id: string;
  title: string;
  cwd: string;
  adapter: string;
  thread: ThreadRef | null;
  active: boolean;
  /** Bumped on every stop; poll results carrying an older generation are ignored. */
  generation: number;
  stopRequested: boolean;
  cursor: string | null;
  /** Adapter message ids the agent itself posted (to filter them out of inbound). */
  ownMessageIds: string[];
  /** Inbound queue for global-ingest adapters. */
  inbox: InboundMsg[];
  createdAt: number;
  lastActivity: number;
}

interface PersistShape {
  version: number;
  sessions: Record<string, SessionRecord>;
}

export class Store {
  private sessions = new Map<string, SessionRecord>();

  constructor() {
    this.load();
  }

  private load(): void {
    ensureRuntimeDir();
    if (!fs.existsSync(STATE_PATH)) return;
    try {
      const data: PersistShape = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
      for (const [id, rec] of Object.entries(data.sessions ?? {})) {
        // In-memory-only fields are rebuilt.
        this.sessions.set(id, { ...rec, inbox: [] });
      }
    } catch {
      // Corrupt state should not crash the daemon.
    }
  }

  persist(): void {
    ensureRuntimeDir();
    const out: PersistShape = { version: 1, sessions: {} };
    for (const [id, rec] of this.sessions) {
      // Do not persist the volatile inbox.
      out.sessions[id] = { ...rec, inbox: [] };
    }
    fs.writeFileSync(STATE_PATH, JSON.stringify(out, null, 2));
  }

  get(id: string): SessionRecord | undefined {
    return this.sessions.get(id);
  }

  all(): SessionRecord[] {
    return [...this.sessions.values()];
  }

  activeSessions(): SessionRecord[] {
    return this.all().filter((s) => s.active);
  }

  upsert(id: string, patch: Partial<SessionRecord> & Pick<SessionRecord, "title" | "cwd" | "adapter">): SessionRecord {
    const existing = this.sessions.get(id);
    const now = Date.now();
    const rec: SessionRecord = existing
      ? { ...existing, ...patch, lastActivity: now }
      : {
          id,
          title: patch.title,
          cwd: patch.cwd,
          adapter: patch.adapter,
          thread: patch.thread ?? null,
          active: patch.active ?? true,
          generation: 0,
          stopRequested: false,
          cursor: null,
          ownMessageIds: [],
          inbox: [],
          createdAt: now,
          lastActivity: now,
        };
    this.sessions.set(id, rec);
    this.persist();
    return rec;
  }

  recordOwnMessage(id: string, messageId: string): void {
    const rec = this.sessions.get(id);
    if (!rec) return;
    rec.ownMessageIds.push(messageId);
    // Keep the list bounded.
    if (rec.ownMessageIds.length > 500) rec.ownMessageIds = rec.ownMessageIds.slice(-500);
    rec.lastActivity = Date.now();
    this.persist();
  }

  isOwnMessage(id: string, messageId: string): boolean {
    return this.sessions.get(id)?.ownMessageIds.includes(messageId) ?? false;
  }

  enqueueInbound(id: string, msg: InboundMsg): void {
    const rec = this.sessions.get(id);
    if (!rec) return;
    if (this.isOwnMessage(id, msg.id)) return;
    if (rec.inbox.some((m) => m.id === msg.id)) return;
    rec.inbox.push(msg);
    rec.lastActivity = Date.now();
  }

  drainInbox(id: string): InboundMsg[] {
    const rec = this.sessions.get(id);
    if (!rec) return [];
    const out = rec.inbox;
    rec.inbox = [];
    return out;
  }

  requestStop(id: string): void {
    const rec = this.sessions.get(id);
    if (!rec) return;
    rec.stopRequested = true;
    rec.generation += 1;
    rec.active = false;
    this.persist();
  }

  setCursor(id: string, cursor: string | null): void {
    const rec = this.sessions.get(id);
    if (!rec) return;
    rec.cursor = cursor;
  }
}
