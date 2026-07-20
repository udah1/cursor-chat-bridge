import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { MARKERS_DIR, ensureRuntimeDir } from "./paths.js";

/**
 * Sessions are keyed by Cursor's `conversation_id` (stable per chat, delivered to hooks).
 * The MCP process cannot see the conversation id directly, so it learns it via a handshake:
 * the beforeSubmitPrompt hook records the current submit just before the agent runs. Layout
 * under ~/.cursor/chat-bridge/markers:
 *   conv/<conversationId>.json      -> Marker (the session for a conversation)
 *   pending/<conversationId>.json   -> PendingStart (a real user submit awaiting bridge_start)
 *   claiming/<conversationId>.json  -> in-flight claim (two-phase: register-then-finalize)
 *   ws/<hash(workspace)>.json       -> { conversationId } (legacy, diagnostics/upgrade-skew only)
 *   last-submit.json                -> { conversationId, workspace } (legacy, diagnostics only)
 *
 * bridge_start does NOT trust the MCP process's own workspace (it can be mis-bound when a
 * global MCP server is shared/misrouted across windows). Instead it CLAIMS the single fresh
 * pending record by the REAL conversation id, so the marker key always equals the id the
 * `stop` hook keys on. When identity is ambiguous or absent it fails closed (never mints).
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

export interface PendingStart {
  conversationId: string;
  workspace: string | null;
  at: number;
}

/** Result of claimStartConversation: either a claimed conversation or a fail-closed reason. */
export type ClaimResult =
  | { conversationId: string; workspace: string | null }
  | { none: "empty" | "stale" | "ambiguous" };

const CONV_DIR = path.join(MARKERS_DIR, "conv");
const WS_DIR = path.join(MARKERS_DIR, "ws");
const PENDING_DIR = path.join(MARKERS_DIR, "pending");
const CLAIMING_DIR = path.join(MARKERS_DIR, "claiming");
const LAST_SUBMIT = path.join(MARKERS_DIR, "last-submit.json");

export function wsHash(workspace: string): string {
  return crypto.createHash("sha1").update(workspace).digest("hex").slice(0, 16);
}

function ensureDirs(): void {
  ensureRuntimeDir();
  fs.mkdirSync(CONV_DIR, { recursive: true });
  fs.mkdirSync(WS_DIR, { recursive: true });
  fs.mkdirSync(PENDING_DIR, { recursive: true });
  fs.mkdirSync(CLAIMING_DIR, { recursive: true });
}

function readJSON<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Atomic write: write to a unique temp file, then rename (atomic on POSIX). */
function writeJSONAtomic(p: string, obj: unknown): void {
  const tmp = `${p}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}

export function writeMarker(m: Marker): void {
  ensureDirs();
  writeJSONAtomic(path.join(CONV_DIR, `${m.conversationId}.json`), m);
}

export function readMarker(conversationId: string): Marker | null {
  if (!conversationId) return null;
  return readJSON<Marker>(path.join(CONV_DIR, `${conversationId}.json`));
}

export function clearMarker(conversationId: string): void {
  if (!conversationId) return;
  const p = path.join(CONV_DIR, `${conversationId}.json`);
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

// --- Pending / claim lifecycle -------------------------------------------------------------

/** Write a pending-start record keyed by the REAL conversation id (used by the hook + tests). */
export function writePending(conversationId: string, workspace: string | null, at = Date.now()): void {
  if (!conversationId) return;
  ensureDirs();
  writeJSONAtomic(path.join(PENDING_DIR, `${conversationId}.json`), { conversationId, workspace, at });
}

function listPending(): PendingStart[] {
  let files: string[] = [];
  try {
    files = fs.readdirSync(PENDING_DIR).filter((f) => f.endsWith(".json") && !f.includes(".tmp-"));
  } catch {
    return [];
  }
  const out: PendingStart[] = [];
  for (const f of files) {
    const rec = readJSON<PendingStart>(path.join(PENDING_DIR, f));
    if (rec?.conversationId && typeof rec.at === "number") out.push(rec);
  }
  return out;
}

/** Delete pending records older than freshMs. Best-effort. */
export function prunePending(now: number, freshMs: number): void {
  for (const rec of listPending()) {
    if (now - rec.at >= freshMs) {
      try {
        fs.rmSync(path.join(PENDING_DIR, `${rec.conversationId}.json`), { force: true });
      } catch {}
    }
  }
}

/**
 * Resolve the conversation for a NEW bridge_start by claiming a pending record.
 *
 * Disambiguation (each Cursor window runs its OWN MCP process with a correct, distinct
 * BRIDGE_WORKSPACE — verified in the field), so we prefer the fresh pending whose workspace
 * matches this process's `workspace`. That makes normal multi-window use unambiguous while
 * still refusing to guess when it genuinely can't tell:
 *  - workspace given & EXACTLY ONE fresh pending matches it -> claim it
 *  - workspace given & MORE THAN ONE matches it -> { none: "ambiguous" } (two chats, one window)
 *  - workspace given & NONE match (or no workspace) -> fall back to the global set:
 *      exactly one fresh pending -> claim it; more than one -> { none: "ambiguous" }
 *  - zero pending files at all -> { none: "empty" } (caller may try the legacy skew fallback)
 *  - had pending(s) but none usable (stale/already-active) -> { none: "stale" }
 */
export function claimStartConversation(now: number, freshMs: number, workspace?: string): ClaimResult {
  ensureDirs();
  const all = listPending();
  if (all.length === 0) return { none: "empty" };

  // Prune stale, keep fresh that don't already have an active marker.
  const candidates: PendingStart[] = [];
  for (const rec of all) {
    if (now - rec.at >= freshMs) {
      try {
        fs.rmSync(path.join(PENDING_DIR, `${rec.conversationId}.json`), { force: true });
      } catch {}
      continue;
    }
    if (readMarker(rec.conversationId)?.active) continue;
    candidates.push(rec);
  }

  if (candidates.length === 0) return { none: "stale" };

  // Prefer workspace-matched candidates; fall back to the global set only if none match (covers
  // the workspace="none"/cwd edge case where the pending's folder label differs from the process).
  let pool = candidates;
  if (workspace) {
    const matched = candidates.filter((c) => c.workspace === workspace);
    if (matched.length > 0) pool = matched;
  }

  if (pool.length > 1) return { none: "ambiguous" };

  const rec = pool[0];
  // Two-phase: atomically move pending -> claiming so a concurrent bridge_start can't take it.
  const src = path.join(PENDING_DIR, `${rec.conversationId}.json`);
  const dst = path.join(CLAIMING_DIR, `${rec.conversationId}.json`);
  try {
    fs.renameSync(src, dst);
  } catch {
    // Lost the race (another claimant took it) or it vanished -> nothing to claim.
    return { none: "stale" };
  }
  return { conversationId: rec.conversationId, workspace: rec.workspace ?? null };
}

/** Commit a claim after a successful register: drop the claiming record. */
export function finalizeClaim(conversationId: string): void {
  try {
    fs.rmSync(path.join(CLAIMING_DIR, `${conversationId}.json`), { force: true });
  } catch {}
}

/** Roll back a claim (e.g. register failed) so a retry can claim it again. */
export function restoreClaim(conversationId: string): void {
  const src = path.join(CLAIMING_DIR, `${conversationId}.json`);
  const dst = path.join(PENDING_DIR, `${conversationId}.json`);
  try {
    fs.renameSync(src, dst);
  } catch {
    try {
      fs.rmSync(src, { force: true });
    } catch {}
  }
}

/** List orphaned claiming records (claim started but never finalized/restored). Diagnostics. */
export function listClaiming(): string[] {
  try {
    return fs
      .readdirSync(CLAIMING_DIR)
      .filter((f) => f.endsWith(".json") && !f.includes(".tmp-"))
      .map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

/**
 * Non-start tools resolve ONLY from the explicit session handle the agent carries from
 * bridge_start. No recency/cache fallback (that caused cross-session bleed under a shared MCP
 * process). Returns the id if a marker exists for it, else null.
 */
export function resolveActiveConversation(explicit?: unknown): string | null {
  if (!explicit) return null;
  const id = String(explicit);
  return readMarker(id) ? id : null;
}

/**
 * Legacy identity resolution, used ONLY as an upgrade-skew fallback when the pending/ dir is
 * empty (an old hook that doesn't write pending records). Prefers the per-workspace pointer,
 * then a workspace-matched last-submit. Never mints. `workspace` is the MCP process workspace.
 */
export function legacyResolve(
  now: number,
  freshMs: number,
  workspace: string,
): { conversationId: string; workspace: string } | null {
  const wsp = readWsPointer(workspace);
  const wsFresh = wsp?.conversationId && now - (wsp.at ?? 0) < freshMs ? wsp.conversationId : null;
  const ls = readLastSubmit();
  const lsFresh =
    ls?.conversationId && ls.workspace === workspace && now - (ls.at ?? 0) < freshMs ? ls.conversationId : null;
  const conversationId = wsFresh ?? lsFresh;
  return conversationId ? { conversationId, workspace } : null;
}
