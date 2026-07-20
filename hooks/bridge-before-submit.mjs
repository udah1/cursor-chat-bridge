#!/usr/bin/env node
// cursor-chat-bridge `beforeSubmitPrompt` hook. Two jobs:
//  1) Handshake: record {conversationId, workspace} for the current submit so the MCP
//     (which can't see conversation_id) can key its session by conversation_id.
//  2) Off-switch: if the user types a real prompt in Cursor while remote chat mode is active
//     for THIS conversation, turn it off. Guards against mistaking the stop-hook's own
//     `followup_message` injection for a real user submit.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";

const RUNTIME = path.join(os.homedir(), ".cursor", "chat-bridge");
const CONFIG_PATH = path.join(RUNTIME, "config.json");
const MARKERS = path.join(RUNTIME, "markers");
const CONV_DIR = path.join(MARKERS, "conv");
const WS_DIR = path.join(MARKERS, "ws");
const PENDING_DIR = path.join(MARKERS, "pending");
const LAST_SUBMIT = path.join(MARKERS, "last-submit.json");
const DAEMON_FILE = path.join(RUNTIME, "daemon.json");
const DEBUG_LOG = path.join(RUNTIME, "hook-stdin.log");
const EXPECT_INJECTION = path.join(RUNTIME, "expect-injection");
const INJECTION_WINDOW_MS = 15000;
const DEFAULT_FRESH_MS = 600000;

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}
function readJSON(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}
function wsHash(ws) {
  return crypto.createHash("sha1").update(ws).digest("hex").slice(0, 16);
}
function writeJSON(p, obj) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // Atomic: write to a unique temp file then rename, so a concurrent reader never sees a torn file.
    const tmp = `${p}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, p);
  } catch {}
}
/** Best-effort prune of pending-start records older than freshMs (bounds accumulation). */
function prunePending(freshMs) {
  let files = [];
  try {
    files = fs.readdirSync(PENDING_DIR).filter((f) => f.endsWith(".json") && !f.includes(".tmp-"));
  } catch {
    return;
  }
  const now = Date.now();
  for (const f of files) {
    const rec = readJSON(path.join(PENDING_DIR, f));
    if (!rec || typeof rec.at !== "number" || now - rec.at >= freshMs) {
      try {
        fs.rmSync(path.join(PENDING_DIR, f), { force: true });
      } catch {}
    }
  }
}
function readConvMarker(conversationId) {
  if (!conversationId) return null;
  return readJSON(path.join(CONV_DIR, `${conversationId}.json`));
}
function clearConvMarker(conversationId) {
  if (!conversationId) return;
  const p = path.join(CONV_DIR, `${conversationId}.json`);
  const m = readJSON(p);
  if (m) writeJSON(p, { ...m, active: false });
  try {
    fs.rmSync(p, { force: true });
  } catch {}
}
function daemonStop(sessionId) {
  return new Promise((resolve) => {
    const d = readJSON(DAEMON_FILE);
    if (!d) return resolve();
    const data = JSON.stringify({ sessionId });
    const req = http.request(
      {
        host: "127.0.0.1",
        port: d.port,
        path: "/stop",
        method: "POST",
        headers: { "Content-Type": "application/json", "x-bridge-token": d.token },
        timeout: 5000,
      },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve());
      }
    );
    req.on("error", () => resolve());
    req.on("timeout", () => {
      req.destroy();
      resolve();
    });
    req.write(data);
    req.end();
  });
}

async function main() {
  const raw = readStdin();
  try {
    fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] SUBMIT ${raw.slice(0, 2000)}\n`);
  } catch {}
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch {}

  const conversationId = payload?.conversation_id;
  const workspace = Array.isArray(payload?.workspace_roots) ? payload.workspace_roots[0] : null;
  const cfg = readJSON(CONFIG_PATH) || {};
  const freshMs = Number.isFinite(Number(cfg.handshakeFreshMs)) && Number(cfg.handshakeFreshMs) > 0
    ? Number(cfg.handshakeFreshMs)
    : DEFAULT_FRESH_MS;

  // Injection guard FIRST: a stop-hook re-arm / reply injection is NOT a real user submit.
  // It must write NO handshake (writing one would clobber another window's pending identity)
  // and must NOT disable remote chat mode.
  const expect = readJSON(EXPECT_INJECTION);
  if (expect && expect.conversationId === conversationId && Date.now() - expect.at < INJECTION_WINDOW_MS) {
    try {
      fs.rmSync(EXPECT_INJECTION, { force: true });
    } catch {}
    process.exit(0);
  }

  // (1) Handshake: record this real submit so bridge_start can CLAIM it by conversation id.
  // The per-conversation pending record is the source of truth; last-submit/ws are kept for
  // diagnostics and upgrade-skew fallback only.
  if (conversationId) {
    const at = Date.now();
    writeJSON(LAST_SUBMIT, { conversationId, workspace: workspace ?? null, at });
    if (workspace) writeJSON(path.join(WS_DIR, `${wsHash(workspace)}.json`), { conversationId, at });
    writeJSON(path.join(PENDING_DIR, `${conversationId}.json`), { conversationId, workspace: workspace ?? null, at });
    prunePending(freshMs);
  }

  // (2) Off-switch: only relevant if remote chat mode is active for this conversation.
  const marker = readConvMarker(conversationId);
  if (!marker || !marker.active) process.exit(0);

  // Off-switch opt-out: if the user set stopRemoteChatOnLocalMessage=false, keep remote chat
  // mode ON even when they type locally in Cursor (default is true -> stop).
  if (cfg.stopRemoteChatOnLocalMessage === false) process.exit(0);

  // Real user submit in Cursor -> disable remote chat mode and notify the thread.
  await daemonStop(marker.sessionId);
  clearConvMarker(conversationId);
  process.exit(0);
}

main();
