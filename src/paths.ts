import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/** All runtime state lives here (config, daemon portfile, session state, logs). */
export const RUNTIME_DIR = path.join(os.homedir(), ".cursor", "chat-bridge");

export const CONFIG_PATH = path.join(RUNTIME_DIR, "config.json");
export const DAEMON_FILE = path.join(RUNTIME_DIR, "daemon.json");
export const STATE_PATH = path.join(RUNTIME_DIR, "state.json");
export const LOG_PATH = path.join(RUNTIME_DIR, "daemon.log");
export const HOOK_DEBUG_PATH = path.join(RUNTIME_DIR, "hook-stdin.log");
/** Marker file the MCP writes so hooks (which run in a separate process) can find the session. */
export const MARKERS_DIR = path.join(RUNTIME_DIR, "markers");
/** Downloaded inbound attachments (images, etc.), grouped per session. */
export const MEDIA_DIR = path.join(RUNTIME_DIR, "media");

export function ensureRuntimeDir(): void {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.mkdirSync(MARKERS_DIR, { recursive: true });
}
