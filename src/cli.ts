#!/usr/bin/env node
import fs from "node:fs";
import { Daemon } from "./daemon.js";
import { CONFIG_PATH, ensureRuntimeDir } from "./paths.js";
import { loadConfig, saveConfig } from "./config.js";
import { createAdapter } from "./adapters/index.js";
import { daemonRequest, isAlive, readDaemonFile } from "./daemonClient.js";
import { runInstall, runUninstall } from "./installer.js";
import { log } from "./logger.js";

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
      console.log(`config: ${CONFIG_PATH}`);
      console.log(`activeAdapter: ${cfg.activeAdapter}`);
      console.log(`pollIntervalMs: ${cfg.pollIntervalMs} (min ${cfg.minPollIntervalMs})`);
      console.log(`daemon alive: ${await isAlive()}`);
      try {
        const a = createAdapter(cfg.activeAdapter, cfg, (m) => console.log("  " + m));
        await a.init();
        console.log(`adapter "${cfg.activeAdapter}": OK ✅`);
      } catch (e: any) {
        console.log(`adapter "${cfg.activeAdapter}": FAILED ❌ ${e?.message ?? e}`);
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
