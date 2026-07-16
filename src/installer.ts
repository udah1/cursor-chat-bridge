import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Self-contained installer used by `chat-bridge install` (i.e. `npx cursor-chat-bridge install`).
 *
 * It copies the packaged runtime (dist + hooks) into ~/.cursor/chat-bridge/app and wires the
 * Cursor integration points to those local paths, so the tool keeps working even if the npx
 * cache is later evicted — no git clone, no global bin on PATH required. Re-running upgrades
 * in place; `uninstall` removes the wiring.
 */

const CURSOR = path.join(os.homedir(), ".cursor");
const MCP_JSON = path.join(CURSOR, "mcp.json");
const HOOKS_JSON = path.join(CURSOR, "hooks.json");
const RULES_DIR = path.join(CURSOR, "rules");
const RUNTIME_DIR = path.join(CURSOR, "chat-bridge");
const APP_DIR = path.join(RUNTIME_DIR, "app");
const CONFIG_PATH = path.join(RUNTIME_DIR, "config.json");

const MCP_KEY = "cursor-chat-bridge";
const RULE_NAME = "chat-bridge-mode.mdc";
const HOOK_STOP = "bridge-stop.mjs";
const HOOK_SUBMIT = "bridge-before-submit.mjs";

/** Package root = parent of dist/ (this file compiles to dist/installer.js). */
function packageRoot(): string {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

function readJSON<T>(p: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJSON(p: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function backup(p: string): void {
  if (fs.existsSync(p)) {
    const b = `${p}.bak-${Date.now()}`;
    fs.copyFileSync(p, b);
    console.log(`  backed up ${path.basename(p)} -> ${path.basename(b)}`);
  }
}

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

/**
 * Write a minimal ESM package.json into APP_DIR and install the package's *production* deps there.
 * Best-effort: if npm isn't available or the network/proxy blocks it, we warn with a copy-paste
 * fix instead of failing the whole install (the runtime is otherwise already in place).
 */
function installRuntimeDeps(root: string): void {
  const rootPkg = readJSON<any>(path.join(root, "package.json"), {});
  const dependencies = rootPkg.dependencies ?? {};
  writeJSON(path.join(APP_DIR, "package.json"), {
    name: "cursor-chat-bridge-runtime",
    version: rootPkg.version ?? "0.0.0",
    private: true,
    type: "module",
    dependencies,
  });

  const names = Object.keys(dependencies);
  if (names.length === 0) return;

  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  try {
    execFileSync(npm, ["install", "--omit=dev", "--no-audit", "--no-fund", "--no-package-lock", "--loglevel=error"], {
      cwd: APP_DIR,
      stdio: "inherit",
    });
    console.log(`✔ installed runtime dependencies (${names.join(", ")})`);
  } catch {
    console.warn(
      [
        "⚠ could not install runtime dependencies automatically.",
        `  Finish the install by running:  (cd ${APP_DIR} && npm install --omit=dev)`,
        "  Behind a corporate proxy, configure npm's proxy first, then re-run the command above.",
      ].join("\n")
    );
  }
}

export function runInstall(): void {
  const root = packageRoot();
  const distSrc = path.join(root, "dist");
  const hooksSrc = path.join(root, "hooks");
  const ruleSrc = path.join(root, "rules", RULE_NAME);
  const exampleSrc = path.join(root, "config.example.json");

  if (!fs.existsSync(path.join(distSrc, "mcp.js"))) {
    throw new Error(`packaged runtime not found at ${distSrc} (build the project first: npm run build)`);
  }

  // 1. Copy the runtime into a stable, self-contained location.
  fs.rmSync(APP_DIR, { recursive: true, force: true });
  copyDir(distSrc, path.join(APP_DIR, "dist"));
  copyDir(hooksSrc, path.join(APP_DIR, "hooks"));
  console.log(`✔ copied runtime -> ${APP_DIR}`);

  // 1b. Make APP_DIR a real ESM package and install its production dependencies locally, so the
  //     runtime resolves @modelcontextprotocol/sdk (and any future deps) on its own — even after
  //     the npx cache it came from is evicted. Without this the copied dist can't be run directly.
  installRuntimeDeps(root);

  const node = process.execPath;
  const mcpEntry = path.join(APP_DIR, "dist", "mcp.js");
  const stopHook = path.join(APP_DIR, "hooks", HOOK_STOP);
  const submitHook = path.join(APP_DIR, "hooks", HOOK_SUBMIT);

  // 2. Register the MCP server (per-window; BRIDGE_WORKSPACE keys sessions to the open project).
  {
    const cfg = readJSON<any>(MCP_JSON, {});
    cfg.mcpServers = cfg.mcpServers || {};
    backup(MCP_JSON);
    cfg.mcpServers[MCP_KEY] = {
      command: node,
      args: [mcpEntry],
      env: { BRIDGE_WORKSPACE: "${workspaceFolder}" },
    };
    writeJSON(MCP_JSON, cfg);
    console.log(`✔ registered MCP server '${MCP_KEY}'`);
  }

  // 3. Install hooks (preserve existing; replace any prior cursor-chat-bridge entries).
  {
    const cfg = readJSON<any>(HOOKS_JSON, { version: 1, hooks: {} });
    cfg.version = cfg.version || 1;
    cfg.hooks = cfg.hooks || {};
    backup(HOOKS_JSON);
    const isOurs = (h: any) => typeof h?.command === "string" && (h.command.includes(HOOK_STOP) || h.command.includes(HOOK_SUBMIT));
    const setHook = (event: string, command: string, extra: Record<string, unknown>) => {
      cfg.hooks[event] = (cfg.hooks[event] || []).filter((h: any) => !isOurs(h));
      cfg.hooks[event].push({ command, ...extra });
    };
    setHook("stop", `${node} ${stopHook}`, { timeout: 3660, loop_limit: 1000 });
    setHook("beforeSubmitPrompt", `${node} ${submitHook}`, { timeout: 10 });
    writeJSON(HOOKS_JSON, cfg);
    console.log("✔ installed 'stop' + 'beforeSubmitPrompt' hooks (no-op unless remote chat mode is active)");
  }

  // 4. Install the activation rule.
  {
    fs.mkdirSync(RULES_DIR, { recursive: true });
    fs.copyFileSync(ruleSrc, path.join(RULES_DIR, RULE_NAME));
    console.log(`✔ installed rule -> ${path.join(RULES_DIR, RULE_NAME)}`);
  }

  // 5. Seed a starter config if none exists (never overwrite an existing one with secrets).
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    const cfg = readJSON<any>(exampleSrc, {});
    writeJSON(CONFIG_PATH, cfg);
    try {
      fs.chmodSync(CONFIG_PATH, 0o600);
    } catch {}
    console.log(`✔ wrote starter config -> ${CONFIG_PATH}`);
  } else {
    console.log(`• kept existing config -> ${CONFIG_PATH}`);
  }

  console.log(
    [
      "",
      "Done. Next:",
      `  1. Edit ${CONFIG_PATH} (choose an adapter and add credentials), or set BRIDGE_* env vars.`,
      "  2. Reload/restart Cursor to load the MCP server + hooks.",
      "  3. In any chat say \"start remote chat mode\" (any language).",
      "",
      "Validate anytime with: chat-bridge doctor",
    ].join("\n")
  );
}

export function runUninstall(purge = false): void {
  // Remove the MCP entry.
  if (fs.existsSync(MCP_JSON)) {
    const cfg = readJSON<any>(MCP_JSON, {});
    if (cfg.mcpServers && cfg.mcpServers[MCP_KEY]) {
      backup(MCP_JSON);
      delete cfg.mcpServers[MCP_KEY];
      writeJSON(MCP_JSON, cfg);
      console.log(`✔ removed MCP server '${MCP_KEY}'`);
    }
  }

  // Remove our hook entries.
  if (fs.existsSync(HOOKS_JSON)) {
    const cfg = readJSON<any>(HOOKS_JSON, { hooks: {} });
    const isOurs = (h: any) =>
      typeof h?.command === "string" && (h.command.includes(HOOK_STOP) || h.command.includes(HOOK_SUBMIT));
    let changed = false;
    for (const event of Object.keys(cfg.hooks || {})) {
      const before = cfg.hooks[event].length;
      cfg.hooks[event] = cfg.hooks[event].filter((h: any) => !isOurs(h));
      if (cfg.hooks[event].length !== before) changed = true;
    }
    if (changed) {
      backup(HOOKS_JSON);
      writeJSON(HOOKS_JSON, cfg);
      console.log("✔ removed hooks");
    }
  }

  // Remove the rule.
  const rule = path.join(RULES_DIR, RULE_NAME);
  if (fs.existsSync(rule)) {
    fs.rmSync(rule, { force: true });
    console.log("✔ removed rule");
  }

  // Remove the copied runtime.
  fs.rmSync(APP_DIR, { recursive: true, force: true });
  console.log("✔ removed runtime app dir");

  if (purge) {
    fs.rmSync(RUNTIME_DIR, { recursive: true, force: true });
    console.log(`✔ purged ${RUNTIME_DIR} (config + state removed)`);
  } else {
    console.log(`• kept ${RUNTIME_DIR} (config + state). Re-run with --purge to remove it too.`);
  }

  console.log("\nDone. Reload/restart Cursor to unload the MCP server + hooks.");
}
