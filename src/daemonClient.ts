import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { DAEMON_FILE } from "./paths.js";
import { loadConfig } from "./config.js";

interface DaemonInfo {
  pid: number;
  port: number;
  token: string;
  version: string;
}

export function readDaemonFile(): DaemonInfo | null {
  if (!fs.existsSync(DAEMON_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(DAEMON_FILE, "utf8"));
  } catch {
    return null;
  }
}

async function ping(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function isAlive(): Promise<boolean> {
  const info = readDaemonFile();
  if (!info) return false;
  return ping(info.port);
}

function daemonEntry(): string {
  // this module lives at dist/daemonClient.js; cli.js is a sibling.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "cli.js");
}

export async function ensureDaemon(): Promise<DaemonInfo> {
  if (await isAlive()) return readDaemonFile()!;

  const cfg = loadConfig();
  const env = { ...process.env };
  const caPath = cfg.caCertPath || process.env.NODE_EXTRA_CA_CERTS;
  if (caPath) env.NODE_EXTRA_CA_CERTS = caPath;

  const child = spawn(process.execPath, [daemonEntry(), "daemon"], {
    detached: true,
    stdio: "ignore",
    env,
  });
  child.unref();

  // Wait for the daemon to come up.
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const info = readDaemonFile();
    if (info && (await ping(info.port))) return info;
  }
  throw new Error("daemon did not start in time (check ~/.cursor/chat-bridge/daemon.log)");
}

export async function daemonRequest(
  method: "GET" | "POST",
  pathname: string,
  body?: unknown,
  timeoutMs = 60000
): Promise<any> {
  const info = await ensureDaemon();
  const r = await fetch(`http://127.0.0.1:${info.port}${pathname}`, {
    method,
    headers: { "Content-Type": "application/json", "x-bridge-token": info.token },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await r.text();
  const json = text ? JSON.parse(text) : {};
  if (!r.ok) throw new Error(json.error || `daemon HTTP ${r.status}`);
  return json;
}
