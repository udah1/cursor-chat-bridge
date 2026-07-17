import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { MARKERS_DIR, ensureRuntimeDir } from "./paths.js";

/**
 * Sessions are keyed by Cursor's `conversation_id` (stable per chat, delivered to hooks).
 * The MCP process cannot see the conversation id directly, so it learns it via a handshake:
 * the beforeSubmitPrompt hook records the current {conversationId, workspace} just before the
 * agent runs. Layout under ~/.cursor/chat-bridge/markers:
 *   conv/<conversationId>.json  -> Marker (the session for a conversation)
 *   ws/<hash(workspace)>.json   -> { conversationId } (active conversation per workspace)
 *   last-submit.json            -> { conversationId, workspace } (most recent prompt submit)
 */
export interface Marker {
  conversationId: string;
  sessionId: string;
  adapter: string;
  thread: string | null;
  workspace: string;
  active: boolean;
  updatedAt: number;
}

export interface SubmitContext {
  conversationId: string;
  workspace: string | null;
  at: number;
}

const CONV_DIR = path.join(MARKERS_DIR, "conv");
const WS_DIR = path.join(MARKERS_DIR, "ws");
const LAST_SUBMIT = path.join(MARKERS_DIR, "last-submit.json");

export function wsHash(workspace: string): string {
  return crypto.createHash("sha1").update(workspace).digest("hex").slice(0, 16);
}

function ensureDirs(): void {
  ensureRuntimeDir();
  fs.mkdirSync(CONV_DIR, { recursive: true });
  fs.mkdirSync(WS_DIR, { recursive: true });
}

function readJSON<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as T;
  } catch {
    return null;
  }
}

export function writeMarker(m: Marker): void {
  ensureDirs();
  fs.writeFileSync(path.join(CONV_DIR, `${m.conversationId}.json`), JSON.stringify(m, null, 2));
  // NOTE: the per-workspace pointer (ws/<hash>.json) is written ONLY by the beforeSubmitPrompt
  // hook, which stamps the *current* conversation id for each submit. bridge_start deliberately
  // does NOT write it here — otherwise a stale pointer from a previous chat could look "fresh"
  // and a brand-new Cursor chat would inherit the previous chat's session/thread.
}

export function readMarker(conversationId: string): Marker | null {
  if (!conversationId) return null;
  return readJSON<Marker>(path.join(CONV_DIR, `${conversationId}.json`));
}

export function clearMarker(conversationId: string): void {
  if (!conversationId) return;
  const p = path.join(CONV_DIR, `${conversationId}.json`);
  const m = readJSON<Marker>(p);
  if (m) {
    try {
      fs.writeFileSync(p, JSON.stringify({ ...m, active: false, updatedAt: Date.now() }, null, 2));
    } catch {}
  }
  try {
    fs.rmSync(p, { force: true });
  } catch {}
}

export function readLastSubmit(): SubmitContext | null {
  return readJSON<SubmitContext>(LAST_SUBMIT);
}

export function readWsPointer(workspace: string): { conversationId: string; at?: number } | null {
  if (!workspace) return null;
  return readJSON<{ conversationId: string; at?: number }>(path.join(WS_DIR, `${wsHash(workspace)}.json`));
}
