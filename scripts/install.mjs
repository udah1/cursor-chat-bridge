#!/usr/bin/env node
// Wire cursor-chat-bridge into ~/.cursor (mcp.json, hooks.json, rules). Non-destructive:
// backs up existing files and merges rather than overwrites.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CURSOR = path.join(os.homedir(), ".cursor");
const MCP_JSON = path.join(CURSOR, "mcp.json");
const HOOKS_JSON = path.join(CURSOR, "hooks.json");
const RULES_DIR = path.join(CURSOR, "rules");

const mjs = (n) => path.join(ROOT, "hooks", n);

function readJSON(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}
function backup(p) {
  if (fs.existsSync(p)) {
    const b = `${p}.bak-${Date.now()}`;
    fs.copyFileSync(p, b);
    console.log(`  backed up ${path.basename(p)} -> ${path.basename(b)}`);
  }
}
function writeJSON(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

// 1. MCP server
{
  const cfg = readJSON(MCP_JSON, {});
  cfg.mcpServers = cfg.mcpServers || {};
  backup(MCP_JSON);
  cfg.mcpServers["cursor-chat-bridge"] = {
    command: process.execPath,
    args: [path.join(ROOT, "dist", "mcp.js")],
    // BRIDGE_WORKSPACE lets the MCP key sessions per Cursor window (Cursor resolves
    // ${workspaceFolder} to the open project root). No CA needed for GitHub/Graph (not
    // TLS-intercepted); for off-box Telegram behind a TLS-intercepting proxy add
    // NODE_EXTRA_CA_CERTS or BRIDGE_CA_CERT here.
    env: { BRIDGE_WORKSPACE: "${workspaceFolder}" },
  };
  writeJSON(MCP_JSON, cfg);
  console.log("✔ registered MCP server 'cursor-chat-bridge'");
}

// 2. Hooks (preserve existing entries; add ours if absent)
{
  const cfg = readJSON(HOOKS_JSON, { version: 1, hooks: {} });
  cfg.version = cfg.version || 1;
  cfg.hooks = cfg.hooks || {};
  backup(HOOKS_JSON);

  const addHook = (event, command, extra) => {
    cfg.hooks[event] = cfg.hooks[event] || [];
    if (!cfg.hooks[event].some((h) => h.command === command)) {
      cfg.hooks[event].push({ command, ...extra });
    }
  };
  // stop: waits for remote reply and re-injects it. Large timeout; bounded by loop_limit.
  addHook("stop", `${process.execPath} ${mjs("bridge-stop.mjs")}`, { timeout: 3660, loop_limit: 1000 });
  // beforeSubmitPrompt: disables bridge mode when the user types directly in Cursor.
  addHook("beforeSubmitPrompt", `${process.execPath} ${mjs("bridge-before-submit.mjs")}`, { timeout: 10 });

  writeJSON(HOOKS_JSON, cfg);
  console.log("✔ installed 'stop' + 'beforeSubmitPrompt' hooks (no-op unless bridge mode is active)");
}

// 3. Rule
{
  fs.mkdirSync(RULES_DIR, { recursive: true });
  const dest = path.join(RULES_DIR, "chat-bridge-mode.mdc");
  fs.copyFileSync(path.join(ROOT, "rules", "chat-bridge-mode.mdc"), dest);
  console.log(`✔ installed rule -> ${dest}`);
}

console.log("\nDone. Reload Cursor (or restart) to load the MCP server + hooks.");
console.log("Then: `chat-bridge doctor` to validate, and say 'start remote chat mode' in a chat.");
