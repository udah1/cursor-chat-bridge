#!/usr/bin/env node
// End-to-end test of the claim-by-conversation-id identity model:
//  - a real submit writes markers/pending/<conversationId>.json (the source of truth)
//  - bridge_start CLAIMS the single fresh pending record (never mints a random id)
//  - ambiguous / stale / missing handshakes FAIL CLOSED (no thread crossing)
//  - non-start tools REQUIRE the session handle
//  - a misrouted MCP (wrong BRIDGE_WORKSPACE) still binds the right conversation
//  - legacy (pre-pending) handshakes still work via the bounded skew fallback
// Requires a running daemon with the `github` adapter configured (same as before).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MARKERS = path.join(os.homedir(), ".cursor", "chat-bridge", "markers");
const PENDING = path.join(MARKERS, "pending");
const CLAIMING = path.join(MARKERS, "claiming");
const CONV = path.join(MARKERS, "conv");
const LAST_SUBMIT = path.join(MARKERS, "last-submit.json");
const DAEMON_FILE = path.join(os.homedir(), ".cursor", "chat-bridge", "daemon.json");
const ADAPTER = "github"; // explicit so the test doesn't depend on config.activeAdapter

function wsHash(ws) {
  return crypto.createHash("sha1").update(ws).digest("hex").slice(0, 16);
}
// A real submit: the beforeSubmit hook writes the per-conversation pending record (source of
// truth) plus the legacy last-submit / ws pointer (diagnostics + upgrade-skew fallback).
function submit(conversationId, workspace, at = Date.now()) {
  fs.mkdirSync(PENDING, { recursive: true });
  fs.mkdirSync(path.join(MARKERS, "ws"), { recursive: true });
  fs.writeFileSync(path.join(PENDING, `${conversationId}.json`), JSON.stringify({ conversationId, workspace, at }));
  fs.writeFileSync(LAST_SUBMIT, JSON.stringify({ conversationId, workspace, at }));
  fs.writeFileSync(path.join(MARKERS, "ws", `${wsHash(workspace)}.json`), JSON.stringify({ conversationId, at }));
}
// A LEGACY submit (old hook): only last-submit + ws pointer, NO pending record.
function legacySubmit(conversationId, workspace, at = Date.now()) {
  fs.mkdirSync(path.join(MARKERS, "ws"), { recursive: true });
  fs.writeFileSync(LAST_SUBMIT, JSON.stringify({ conversationId, workspace, at }));
  fs.writeFileSync(path.join(MARKERS, "ws", `${wsHash(workspace)}.json`), JSON.stringify({ conversationId, at }));
}
function clearPending() {
  for (const d of [PENDING, CLAIMING]) {
    try {
      for (const f of fs.readdirSync(d)) fs.rmSync(path.join(d, f), { force: true });
    } catch {}
  }
  try {
    fs.rmSync(LAST_SUBMIT, { force: true });
  } catch {}
}
function readConvMarker(cid) {
  try {
    return JSON.parse(fs.readFileSync(path.join(CONV, `${cid}.json`), "utf8"));
  } catch {
    return null;
  }
}
async function mcp(workspace, fn) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "dist", "mcp.js")],
    cwd: root,
    env: { ...process.env, BRIDGE_WORKSPACE: workspace },
  });
  const client = new Client({ name: "e2e", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}
const callText = async (client, name, args = {}) =>
  (await client.callTool({ name, arguments: args })).content?.[0]?.text ?? "";

function daemonStop(sessionId) {
  return new Promise((resolve) => {
    let d;
    try {
      d = JSON.parse(fs.readFileSync(DAEMON_FILE, "utf8"));
    } catch {
      return resolve();
    }
    const data = JSON.stringify({ sessionId });
    const req = http.request(
      { host: "127.0.0.1", port: d.port, path: "/stop", method: "POST", headers: { "Content-Type": "application/json", "x-bridge-token": d.token } },
      (res) => { res.on("data", () => {}); res.on("end", resolve); }
    );
    req.on("error", resolve);
    req.write(data);
    req.end();
  });
}

let failures = 0;
const assert = (cond, msg) => { console.log(`${cond ? "✅" : "❌"} ${msg}`); if (!cond) failures++; };

const stamp = Date.now();
const A = `e2e-A-${stamp}`;
const B = `e2e-B-${stamp}`;
const M = `e2e-MISROUTE-${stamp}`;
const C = `e2e-C-${stamp}`;
const D = `e2e-D-${stamp}`;
const S = `e2e-STALE-${stamp}`;
const T = `e2e-ONBOARD-${stamp}`;
const L = `e2e-LEGACY-${stamp}`;
const WA = "/tmp/ccb-e2e/projectA";
const WB = "/tmp/ccb-e2e/projectB";
const WM = "/tmp/ccb-e2e/projectM";
const WL = "/tmp/ccb-e2e/projectLegacy";
const FRESH_MS = 600000;

// 1) One fresh pending per start -> the marker is keyed by the REAL conversation id (never a uuid).
clearPending();
submit(A, WA);
const startA = await mcp(WA, (c) => callText(c, "bridge_start", { title: "convA", adapter: ADAPTER }));
console.log("START A:", startA.slice(0, 100));
submit(B, WB);
const startB = await mcp(WB, (c) => callText(c, "bridge_start", { title: "convB", adapter: ADAPTER }));
const mA = readConvMarker(A);
const mB = readConvMarker(B);
assert(!!mA && mA.conversationId === A, `marker A keyed by real conversation id (${A})`);
assert(!!mB && mB.conversationId === B, `marker B keyed by real conversation id (${B})`);
assert(mA?.thread && mB?.thread && mA.thread !== mB.thread, `distinct threads (A=${mA?.thread} B=${mB?.thread})`);
assert(!fs.existsSync(path.join(PENDING, `${A}.json`)) && !fs.existsSync(path.join(CLAIMING, `${A}.json`)), "A's pending consumed + claim finalized");

// 2) Non-start tools REQUIRE the session handle.
const noSession = await mcp(WA, (c) => callText(c, "bridge_send", { text: "hi" }));
assert(/missing required 'session'/i.test(noSession), "bridge_send without session is rejected");
const sendA = await mcp(WA, (c) => callText(c, "bridge_send", { text: "hello from A", session: A }));
assert(sendA === "sent", "bridge_send with session=A routes to A");

// 3) Misrouted MCP: BRIDGE_WORKSPACE is WRONG, but the single fresh pending still binds the
//    right conversation AND its own workspace (claim wins over the process's env).
clearPending();
submit(M, WM);
const startM = await mcp("/tmp/ccb-e2e/WRONG-workspace", (c) => callText(c, "bridge_start", { title: "convM", adapter: ADAPTER }));
console.log("START M (misrouted):", startM.slice(0, 100));
const mM = readConvMarker(M);
assert(!!mM && mM.conversationId === M, `misrouted start still binds real id ${M}`);
assert(mM?.workspace === WM, `misrouted start uses the CLAIM's workspace (${WM}), not the MCP env`);

// 4) Ambiguous: two fresh pendings in the SAME workspace -> FAIL CLOSED, nothing minted.
clearPending();
const WSAME = "/tmp/ccb-e2e/pShared";
submit(C, WSAME);
submit(D, WSAME);
const amb = await mcp(WSAME, (c) => callText(c, "bridge_start", { title: "ambiguous", adapter: ADAPTER }));
assert(/more than one chat in this same project folder/i.test(amb), "same-folder ambiguous start fails closed");
assert(!readConvMarker(C) && !readConvMarker(D), "ambiguous start minted NO markers");
assert(fs.existsSync(path.join(PENDING, `${C}.json`)) && fs.existsSync(path.join(PENDING, `${D}.json`)), "ambiguous start consumed nothing");

// 5) Stale: only an old pending -> FAIL CLOSED (stale).
clearPending();
submit(S, "/tmp/ccb-e2e/ps", Date.now() - FRESH_MS - 5000);
const stale = await mcp("/tmp/ccb-e2e/ps", (c) => callText(c, "bridge_start", { title: "stale", adapter: ADAPTER }));
assert(/stale or already claimed/i.test(stale), "stale start fails closed with guidance");
assert(!readConvMarker(S), "stale start minted NO marker");

// 6) Onboarding does NOT consume the pending claim.
clearPending();
submit(T, "/tmp/ccb-e2e/pt");
const onboard = await mcp("/tmp/ccb-e2e/pt", (c) => callText(c, "bridge_start", { adapter: "telegram" }));
assert(/botToken/i.test(onboard) && /BotFather/i.test(onboard), "telegram onboarding guidance returned");
assert(fs.existsSync(path.join(PENDING, `${T}.json`)), "onboarding did NOT consume the pending claim");

// 7) Legacy skew: no pending record (old hook) -> bounded fallback still starts.
clearPending();
legacySubmit(L, WL);
const legacy = await mcp(WL, (c) => callText(c, "bridge_start", { title: "legacy", adapter: ADAPTER }));
console.log("START L (legacy):", legacy.slice(0, 120));
const mL = readConvMarker(L);
assert(!!mL && mL.conversationId === L, `legacy fallback binds real id ${L}`);
assert(/legacy handshake/i.test(legacy), "legacy start warns about out-of-date hooks");

// 8) No random-uuid markers were ever minted by this run.
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i;
let mintedUuids = 0;
try {
  for (const f of fs.readdirSync(CONV)) {
    if (!uuidRe.test(f)) continue;
    // Only count ones freshly created during this run.
    const st = fs.statSync(path.join(CONV, f));
    if (st.mtimeMs >= stamp) mintedUuids++;
  }
} catch {}
assert(mintedUuids === 0, `no random-uuid conv markers minted during the run (found ${mintedUuids})`);

// Cleanup.
clearPending();
await daemonStop(A);
await daemonStop(B);
await daemonStop(M);
await daemonStop(L);

console.log(failures === 0 ? "\nALL E2E CHECKS PASSED" : `\n${failures} E2E CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
