#!/usr/bin/env node
// cursor-chat-bridge `beforeSubmitPrompt` hook.
// If the user types a prompt directly in Cursor while bridge mode is active, that
// means they came back to the IDE -> turn bridge mode OFF. Guards against mistaking
// the stop-hook's own `followup_message` injection for a real user submit.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";

const RUNTIME = path.join(os.homedir(), ".cursor", "chat-bridge");
const MARKERS = path.join(RUNTIME, "markers");
const DAEMON_FILE = path.join(RUNTIME, "daemon.json");
const DEBUG_LOG = path.join(RUNTIME, "hook-stdin.log");
const EXPECT_INJECTION = path.join(RUNTIME, "expect-injection");
const INJECTION_WINDOW_MS = 15000;

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
function resolveCwd(payload) {
  if (!payload) return process.cwd();
  return (
    (Array.isArray(payload.workspace_roots) && payload.workspace_roots[0]) ||
    payload.workspaceRoot ||
    payload.cwd ||
    payload.workspace ||
    process.cwd()
  );
}
function readMarker(cwd) {
  if (cwd) {
    const key = crypto.createHash("sha1").update(cwd).digest("hex").slice(0, 16);
    const byCwd = readJSON(path.join(MARKERS, `${key}.json`));
    if (byCwd) return byCwd;
  }
  return readJSON(path.join(MARKERS, "latest.json"));
}
function clearMarker(cwd) {
  try {
    if (cwd) {
      const key = crypto.createHash("sha1").update(cwd).digest("hex").slice(0, 16);
      fs.rmSync(path.join(MARKERS, `${key}.json`), { force: true });
    }
    const latest = readJSON(path.join(MARKERS, "latest.json"));
    if (latest) fs.writeFileSync(path.join(MARKERS, "latest.json"), JSON.stringify({ ...latest, active: false }));
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

  const cwd = resolveCwd(payload);
  const marker = readMarker(cwd);
  if (!marker || !marker.active) process.exit(0); // not in bridge mode -> allow prompt, do nothing

  // Injection guard: if the stop hook just re-injected a remote reply, this "submit"
  // is not a real user keystroke -> keep bridge mode on.
  const expect = readJSON(EXPECT_INJECTION);
  if (expect && Date.now() - expect.at < INJECTION_WINDOW_MS) {
    try {
      fs.rmSync(EXPECT_INJECTION, { force: true });
    } catch {}
    process.exit(0);
  }

  // Real user submit in Cursor -> disable bridge mode and notify the thread.
  await daemonStop(marker.sessionId);
  clearMarker(cwd);
  process.exit(0);
}

main();
