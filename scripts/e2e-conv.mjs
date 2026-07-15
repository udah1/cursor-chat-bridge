#!/usr/bin/env node
// End-to-end test of per-conversation routing, stale-stop recovery, and onboarding guidance.
// Drives the built MCP over stdio the way Cursor would, simulating the beforeSubmit handshake.
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
const LAST_SUBMIT = path.join(MARKERS, "last-submit.json");
const DAEMON_FILE = path.join(os.homedir(), ".cursor", "chat-bridge", "daemon.json");

// Mirror exactly what the real beforeSubmitPrompt hook writes: the global last-submit AND the
// per-workspace pointer (ws/<hash(workspace)>.json). bridge_start prefers the per-workspace
// pointer, so omitting it here would not reflect production behaviour.
function wsHash(ws) {
  return crypto.createHash("sha1").update(ws).digest("hex").slice(0, 16);
}
function writeHandshake(conversationId, workspace) {
  fs.mkdirSync(MARKERS, { recursive: true });
  fs.mkdirSync(path.join(MARKERS, "ws"), { recursive: true });
  fs.writeFileSync(LAST_SUBMIT, JSON.stringify({ conversationId, workspace, at: Date.now() }));
  fs.writeFileSync(
    path.join(MARKERS, "ws", `${wsHash(workspace)}.json`),
    JSON.stringify({ conversationId, at: Date.now() })
  );
}
function readConvMarker(cid) {
  try {
    return JSON.parse(fs.readFileSync(path.join(MARKERS, "conv", `${cid}.json`), "utf8"));
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

// Stop a session directly via the daemon loopback (simulates a remote `stop`).
function daemonStop(sessionId) {
  return new Promise((resolve) => {
    const d = JSON.parse(fs.readFileSync(DAEMON_FILE, "utf8"));
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

const A = "e2e-conv-AAAA-" + Date.now();
const B = "e2e-conv-BBBB-" + Date.now();
const WA = "/tmp/ccb-e2e/projectA";
const WB = "/tmp/ccb-e2e/projectB";

// 1) Two conversations in different workspaces -> two distinct issues.
writeHandshake(A, WA);
const startA = await mcp(WA, (c) => callText(c, "bridge_start", { title: "convA" }));
console.log("START A:", startA.slice(0, 120));
writeHandshake(B, WB);
const startB = await mcp(WB, (c) => callText(c, "bridge_start", { title: "convB" }));
console.log("START B:", startB.slice(0, 120));

const mA = readConvMarker(A);
const mB = readConvMarker(B);
assert(!!mA && !!mB, "both conversation markers written");
assert(mA?.thread && mB?.thread && mA.thread !== mB.thread, `distinct threads (A=${mA?.thread} B=${mB?.thread})`);

// 2) Sending from conv A resolves to A's session even though B started most recently.
const sendA = await mcp(WA, (c) => callText(c, "bridge_send", { text: "hello from A" }));
assert(sendA === "sent", "conv A send routed to A's own session (workspace pointer wins over last-submit)");

// 3) Stale-stop recovery: stop A, then re-start A -> fresh thread, and await is NOT instantly 'stopped'.
await daemonStop(A);
writeHandshake(A, WA);
const restartA = await mcp(WA, (c) => callText(c, "bridge_start", { title: "convA again" }));
const mA2 = readConvMarker(A);
assert(mA2?.thread && mA2.thread !== mA?.thread, `re-start opens a FRESH thread (was ${mA?.thread}, now ${mA2?.thread})`);
const awaitA = await mcp(WA, (c) => callText(c, "bridge_send_and_await", { text: "still alive?", maxBlockMs: 1500 }));
let awaitStatus = "";
try { awaitStatus = JSON.parse(awaitA).status; } catch {}
assert(awaitStatus === "timeout", `await after re-start returns '${awaitStatus}' (expected 'timeout', NOT 'stopped')`);

// 3b) Two conversations in the SAME workspace: explicit session handle keeps them separate.
const C = "e2e-conv-CCCC-" + Date.now();
const D = "e2e-conv-DDDD-" + Date.now();
const WC = "/tmp/ccb-e2e/projectShared";
writeHandshake(C, WC);
await mcp(WC, (c) => callText(c, "bridge_start", { title: "convC" }));
writeHandshake(D, WC);
await mcp(WC, (c) => callText(c, "bridge_start", { title: "convD" }));
const mC = readConvMarker(C);
const mD = readConvMarker(D);
assert(mC?.thread && mD?.thread && mC.thread !== mD.thread, `same-workspace: distinct threads (C=${mC?.thread} D=${mD?.thread})`);
// The workspace pointer now points at D (started last). Explicit session=C must still win.
const statusC = await mcp(WC, (c) => callText(c, "bridge_status", { session: C }));
let scThread = null;
try { scThread = JSON.parse(statusC).session?.thread?.thread; } catch {}
assert(scThread === mC.thread, `explicit session=C resolves to C's thread ${mC?.thread} (got ${scThread}) despite D starting last`);
await daemonStop(C);
await daemonStop(D);

// 4) Onboarding: telegram without config returns guidance, not an error/thread.
const tg = await mcp("/tmp/ccb-e2e/projectC", (c) => callText(c, "bridge_start", { adapter: "telegram" }));
assert(/botToken/i.test(tg) && /BotFather/i.test(tg), "telegram onboarding guidance returned when unconfigured");
console.log("TELEGRAM GUIDANCE:", tg.slice(0, 100));

// Cleanup sessions we created.
await daemonStop(A);
await daemonStop(B);

console.log(failures === 0 ? "\nALL E2E CHECKS PASSED" : `\n${failures} E2E CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
