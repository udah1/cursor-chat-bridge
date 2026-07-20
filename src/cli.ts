#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { Daemon } from "./daemon.js";
import { CONFIG_PATH, HOOK_DEBUG_PATH, MARKERS_DIR, RUNTIME_DIR, ensureRuntimeDir } from "./paths.js";
import { loadConfig, saveConfig } from "./config.js";
import { createAdapter } from "./adapters/index.js";
import { createSttProvider } from "./stt.js";
import { daemonRequest, isAlive, readDaemonFile } from "./daemonClient.js";
import { runInstall, runUninstall } from "./installer.js";
import { currentVersion } from "./version.js";
import { log } from "./logger.js";

/** Best-effort: find running MCP processes and the workspace each is bound to (BRIDGE_WORKSPACE). */
function findMcpProcesses(): { pid: number; workspace: string }[] {
  const out: { pid: number; workspace: string }[] = [];
  if (process.platform === "win32") return out; // best-effort: skip on Windows
  let ps = "";
  try {
    ps = execSync("ps -eo pid=,args=", { encoding: "utf8" });
  } catch {
    return out;
  }
  for (const line of ps.split("\n")) {
    if (!line.includes("mcp.js") || !line.includes("chat-bridge")) continue;
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    let workspace = "?";
    try {
      if (process.platform === "linux") {
        const env = fs.readFileSync(`/proc/${pid}/environ`, "utf8");
        const kv = env.split("\0").find((s) => s.startsWith("BRIDGE_WORKSPACE="));
        if (kv) workspace = kv.slice("BRIDGE_WORKSPACE=".length);
      } else {
        // macOS/BSD: `ps eww` appends the process environment after the command.
        const e = execSync(`ps eww -o command= -p ${pid}`, { encoding: "utf8" });
        const kv = e.split(/\s+/).find((s) => s.startsWith("BRIDGE_WORKSPACE="));
        if (kv) workspace = kv.slice("BRIDGE_WORKSPACE=".length);
      }
    } catch {}
    out.push({ pid, workspace });
  }
  return out;
}

function readJsonSafe<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as T;
  } catch {
    return null;
  }
}

function listJsonRecords(dir: string): { id: string; at: number; raw: any }[] {
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.includes(".tmp-"));
  } catch {
    return [];
  }
  const out: { id: string; at: number; raw: any }[] = [];
  for (const f of files) {
    const raw = readJsonSafe<any>(path.join(dir, f));
    out.push({ id: f.replace(/\.json$/, ""), at: Number(raw?.at ?? raw?.updatedAt ?? 0), raw });
  }
  return out;
}

function fmtAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${Math.round(ms / 3600000)}h`;
}

/** Identity/session diagnostics: MCP process binding, handshake freshness, claim health. */
function diagnoseIdentity(handshakeFreshMs: number): void {
  const now = Date.now();
  console.log("\n— identity / sessions —");

  const appVer = readJsonSafe<{ version?: string }>(path.join(RUNTIME_DIR, "app-version.json"));
  console.log(`installed app version: ${appVer?.version ?? "unknown"}; this CLI: ${currentVersion()}`);
  if (appVer?.version && appVer.version !== currentVersion()) {
    console.log(
      "  ⚠️  version skew: the installed runtime differs from this CLI. Run " +
        "`npx cursor-telegram-chat@latest install`, then FULLY quit + reopen Cursor.",
    );
  }

  const procs = findMcpProcesses();
  if (procs.length === 0) {
    console.log("mcp processes: none detected (or unsupported OS). Start/reopen Cursor to launch them.");
  } else {
    console.log(`mcp processes: ${procs.length}`);
    const byWs = new Map<string, number[]>();
    for (const p of procs) {
      console.log(`  pid ${p.pid} → BRIDGE_WORKSPACE=${p.workspace}`);
      byWs.set(p.workspace, [...(byWs.get(p.workspace) ?? []), p.pid]);
    }
    for (const [ws, pids] of byWs) {
      if (ws !== "?" && pids.length > 1)
        console.log(`  ℹ️  ${pids.length} MCP processes share workspace ${ws} (pids ${pids.join(", ")}).`);
    }
  }

  console.log(`handshakeFreshMs: ${handshakeFreshMs} (${fmtAge(handshakeFreshMs)})`);

  const pending = listJsonRecords(path.join(MARKERS_DIR, "pending"));
  const freshPending = pending.filter((r) => now - r.at < handshakeFreshMs);
  const stalePending = pending.filter((r) => now - r.at >= handshakeFreshMs);
  if (pending.length === 0) {
    console.log("pending starts: none (a real submit writes markers/pending/<conversationId>.json)");
  } else {
    const oldest = Math.max(...pending.map((r) => now - r.at));
    console.log(`pending starts: ${pending.length} (fresh ${freshPending.length}, stale ${stalePending.length}; oldest ${fmtAge(oldest)})`);
    if (stalePending.length > 0) console.log("  ℹ️  stale pending records are pruned automatically on the next bridge_start / submit.");
  }

  const claiming = listJsonRecords(path.join(MARKERS_DIR, "claiming"));
  if (claiming.length > 0) {
    console.log(`⚠️  orphaned claims: ${claiming.length} in markers/claiming/ (a register likely failed mid-claim).`);
    console.log("  Safe to delete when no bridge_start is in flight: rm ~/.cursor/chat-bridge/markers/claiming/*.json");
  }

  const conv = listJsonRecords(path.join(MARKERS_DIR, "conv"));
  const active = conv.filter((r) => r.raw?.active);
  if (active.length === 0) {
    console.log("active sessions: none");
  } else {
    console.log(`active sessions: ${active.length}`);
    const byWs = new Map<string, string[]>();
    for (const r of active) {
      const ws = r.raw?.workspace ?? "?";
      console.log(`  ${r.id} → ${ws} (adapter ${r.raw?.adapter ?? "?"}, thread ${r.raw?.thread ?? "?"})`);
      byWs.set(ws, [...(byWs.get(ws) ?? []), r.id]);
    }
    for (const [ws, ids] of byWs) {
      if (ids.length > 1) console.log(`  ℹ️  ${ids.length} active sessions in workspace ${ws} (expected if you run multiple chats there).`);
    }
  }
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case "install": {
      runInstall();
      break;
    }

    case "uninstall": {
      runUninstall(args.includes("--purge"));
      break;
    }

    case "daemon": {
      // Ensure the CA cert is trusted for outbound HTTPS (this machine intercepts TLS).
      const cfg = loadConfig();
      if ((cfg.caCertPath || process.env.NODE_EXTRA_CA_CERTS) && !process.env.NODE_EXTRA_CA_CERTS) {
        process.env.NODE_EXTRA_CA_CERTS = cfg.caCertPath;
      }
      const d = new Daemon();
      const { port } = await d.start();
      log(`daemon ready on ${port}`);
      process.on("SIGINT", () => process.exit(0));
      process.on("SIGTERM", () => process.exit(0));
      // Keep alive.
      await new Promise(() => {});
      break;
    }

    case "init": {
      ensureRuntimeDir();
      if (fs.existsSync(CONFIG_PATH)) {
        console.log(`Config already exists at ${CONFIG_PATH}`);
      } else {
        const example = new URL("../config.example.json", import.meta.url);
        const cfg = JSON.parse(fs.readFileSync(example, "utf8"));
        saveConfig(cfg);
        console.log(`Wrote starter config to ${CONFIG_PATH} (edit it, then run: chat-bridge doctor)`);
      }
      break;
    }

    case "doctor": {
      const cfg = loadConfig();
      // Trust the corporate CA for the adapter's outbound HTTPS check (same as the daemon does).
      if (cfg.caCertPath && !process.env.NODE_EXTRA_CA_CERTS) {
        process.env.NODE_EXTRA_CA_CERTS = cfg.caCertPath;
      }
      console.log(`config: ${CONFIG_PATH}`);
      console.log(`activeAdapter: ${cfg.activeAdapter}`);
      console.log(`pollIntervalMs: ${cfg.pollIntervalMs} (min ${cfg.minPollIntervalMs})`);
      // STT: show exactly which provider will be used (diagnoses "why is it using local?").
      if (!cfg.stt?.enabled) {
        console.log("stt: disabled");
      } else {
        const stt = cfg.stt;
        const wantsLocal = stt.provider === "local" || stt.tryLocalSttFirst;
        const prov = createSttProvider(stt);
        if (wantsLocal) {
          console.log(`stt: local "${stt.localBin}" ${prov ? "OK ✅" : "FAILED ❌"}`);
        } else if (prov) {
          console.log(`stt: cloud "${stt.provider}" via ${stt.baseUrl} — key resolved ✅`);
        } else {
          console.log(`stt: cloud "${stt.provider}" but NO API key resolved ❌ (set stt.apiKey / stt.apiKeyCommand)`);
        }
      }
      console.log(`daemon alive: ${await isAlive()}`);
      // Hooks health: the beforeSubmitPrompt hook stamps each chat's conversation id (so every
      // Cursor chat gets its OWN thread) and is the off-switch. If it never ran, warn — without it
      // a new chat can inherit a previous chat's thread.
      if (fs.existsSync(HOOK_DEBUG_PATH)) {
        const age = Date.now() - fs.statSync(HOOK_DEBUG_PATH).mtimeMs;
        const days = Math.floor(age / 86400000);
        const offSwitch = cfg.stopRemoteChatOnLocalMessage === false ? "off (stays on when you type)" : "on (type-to-stop)";
        console.log(`hooks: installed ✅ (last submit ${days === 0 ? "today" : days + "d ago"}); off-switch: ${offSwitch}`);
      } else {
        console.log(
          "hooks: NOT detected ⚠️  — the beforeSubmitPrompt hook hasn't run. Per-conversation " +
            "threads and the type-to-stop off-switch need it. Re-run `npx cursor-telegram-chat@latest install` and reload Cursor.",
        );
      }
      diagnoseIdentity(cfg.handshakeFreshMs ?? 600000);
      try {
        const a = createAdapter(cfg.activeAdapter, cfg, (m) => console.log("  " + m));
        await a.init();
        console.log(`\nadapter "${cfg.activeAdapter}": OK ✅`);
      } catch (e: any) {
        console.log(`\nadapter "${cfg.activeAdapter}": FAILED ❌ ${e?.message ?? e}`);
        process.exitCode = 1;
      }
      break;
    }

    case "status": {
      const info = readDaemonFile();
      if (!info) return void console.log("daemon not running");
      const s = await daemonRequest("GET", "/status");
      console.log(JSON.stringify(s, null, 2));
      break;
    }

    case "register": {
      const [sessionId, ...titleParts] = args;
      const title = titleParts.join(" ") || sessionId;
      const r = await daemonRequest("POST", "/register", { sessionId, title, cwd: process.cwd() });
      console.log(JSON.stringify(r, null, 2));
      break;
    }

    case "send": {
      const [sessionId, ...textParts] = args;
      const r = await daemonRequest("POST", "/send", { sessionId, text: textParts.join(" ") });
      console.log(JSON.stringify(r, null, 2));
      break;
    }

    case "poll": {
      const [sessionId, waitMs] = args;
      const r = await daemonRequest("GET", `/poll?sessionId=${encodeURIComponent(sessionId)}&waitMs=${waitMs ?? 0}`, undefined, 60000);
      console.log(JSON.stringify(r, null, 2));
      break;
    }

    case "stop": {
      const [sessionId] = args;
      const r = await daemonRequest("POST", "/stop", { sessionId, closeThread: args.includes("--close") });
      console.log(JSON.stringify(r, null, 2));
      break;
    }

    case "shutdown": {
      if (!(await isAlive())) return void console.log("daemon not running");
      await daemonRequest("POST", "/shutdown", {});
      console.log("daemon shutdown requested");
      break;
    }

    default:
      console.log(
        [
          "cursor-chat-bridge",
          "",
          "Usage: chat-bridge <command>",
          "  install                wire into ~/.cursor (MCP + hooks + rule); no clone needed",
          "  uninstall [--purge]    remove the wiring (--purge also deletes config + state)",
          "  daemon                 run the daemon (foreground)",
          "  init                   write a starter config to ~/.cursor/chat-bridge/config.json",
          "  doctor                 validate config + active adapter",
          "  status                 show daemon + sessions",
          "  register <id> <title>  register a session",
          "  send <id> <text...>    post a message to a session thread",
          "  poll <id> [waitMs]     poll a session for replies",
          "  stop <id> [--close]    stop a session",
          "  shutdown               stop the daemon",
        ].join("\n")
      );
  }
}

main().catch((e) => {
  console.error(e?.stack ?? String(e));
  process.exit(1);
});
