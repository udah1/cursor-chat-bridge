import fs from "node:fs";
import { execSync } from "node:child_process";
import { CONFIG_PATH, ensureRuntimeDir } from "./paths.js";
import type { NotifyConfig } from "./notify.js";
import { STT_DEFAULTS, type SttConfig } from "./stt.js";

export interface BridgeConfig {
  activeAdapter: string;
  pollIntervalMs: number;
  minPollIntervalMs: number;
  awaitTimeoutMs: number;
  caCertPath?: string;
  requireConfirmForDestructive?: boolean;
  adapters: Record<string, any>;
  /** Optional out-of-band push (e.g. ntfy) so you get a phone alert on each summary. */
  notify?: NotifyConfig;
  /** Speech-to-text (voice message transcription). Disabled by default. */
  stt?: SttConfig;
}

const DEFAULTS: BridgeConfig = {
  activeAdapter: "telegram",
  pollIntervalMs: 10000,
  minPollIntervalMs: 2000,
  awaitTimeoutMs: 30 * 60 * 1000,
  caCertPath: "",
  requireConfirmForDestructive: true,
  adapters: {},
  // ntfy push is OFF by default; enable it only via BRIDGE_NTFY_* env on the MCP entry.
};

export function loadConfig(): BridgeConfig {
  ensureRuntimeDir();
  let raw: Partial<BridgeConfig> = {};
  if (fs.existsSync(CONFIG_PATH)) {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  }
  const cfg: BridgeConfig = { ...DEFAULTS, ...raw, adapters: raw.adapters ?? {} };
  cfg.stt = { ...STT_DEFAULTS, ...(raw.stt ?? {}) };
  applyEnvOverrides(cfg);
  // minPollIntervalMs is the real knob; keep a small absolute floor (1s) to avoid hammering APIs.
  cfg.pollIntervalMs = Math.max(cfg.pollIntervalMs, cfg.minPollIntervalMs, 1000);
  return cfg;
}

/**
 * Env-var overrides (BRIDGE_*). Useful to set the platform/interval per MCP server
 * instance from ~/.cursor/mcp.json without editing config.json. A change requires a
 * daemon restart (`chat-bridge shutdown`) to take effect on an already-running daemon.
 */
export function applyEnvOverrides(cfg: BridgeConfig): void {
  const e = process.env;
  if (e.BRIDGE_PLATFORM) cfg.activeAdapter = e.BRIDGE_PLATFORM.trim();
  if (e.BRIDGE_POLL_INTERVAL) {
    const sec = Number(e.BRIDGE_POLL_INTERVAL);
    if (Number.isFinite(sec) && sec > 0) cfg.pollIntervalMs = Math.round(sec * 1000);
  }
  if (e.BRIDGE_CA_CERT) cfg.caCertPath = e.BRIDGE_CA_CERT;

  cfg.adapters = cfg.adapters ?? {};
  const gh = (cfg.adapters.github = cfg.adapters.github ?? {});
  if (e.BRIDGE_GITHUB_TOKEN) gh.token = e.BRIDGE_GITHUB_TOKEN;
  if (e.BRIDGE_GITHUB_REPO) {
    const [owner, repo] = e.BRIDGE_GITHUB_REPO.split("/");
    if (owner) gh.owner = owner;
    if (repo) gh.repo = repo;
  }
  const tg = (cfg.adapters.telegram = cfg.adapters.telegram ?? {});
  if (e.BRIDGE_TELEGRAM_BOT_TOKEN) tg.botToken = e.BRIDGE_TELEGRAM_BOT_TOKEN;
  if (e.BRIDGE_TELEGRAM_CHAT_ID) tg.chatId = e.BRIDGE_TELEGRAM_CHAT_ID;
  if (e.BRIDGE_TELEGRAM_ALLOWED_USER_IDS) {
    tg.allowedUserIds = e.BRIDGE_TELEGRAM_ALLOWED_USER_IDS.split(",").map((s) => s.trim()).filter(Boolean);
  }

  const dc = (cfg.adapters.discord = cfg.adapters.discord ?? {});
  if (e.BRIDGE_DISCORD_BOT_TOKEN) dc.botToken = e.BRIDGE_DISCORD_BOT_TOKEN;
  if (e.BRIDGE_DISCORD_CHANNEL_ID) dc.channelId = e.BRIDGE_DISCORD_CHANNEL_ID;
  if (e.BRIDGE_DISCORD_ALLOWED_USER_IDS) {
    dc.allowedUserIds = e.BRIDGE_DISCORD_ALLOWED_USER_IDS.split(",").map((s) => s.trim()).filter(Boolean);
  }

  const stt = (cfg.stt = cfg.stt ?? { ...STT_DEFAULTS });
  if (e.BRIDGE_STT_ENABLED) stt.enabled = /^(1|true|yes|on)$/i.test(e.BRIDGE_STT_ENABLED.trim());
  if (e.BRIDGE_STT_PROVIDER) {
    const p = e.BRIDGE_STT_PROVIDER.trim();
    if (p === "openai" || p === "local") stt.provider = p;
  }
  if (e.BRIDGE_STT_TRY_LOCAL_FIRST) stt.tryLocalSttFirst = /^(1|true|yes|on)$/i.test(e.BRIDGE_STT_TRY_LOCAL_FIRST.trim());
  if (e.BRIDGE_STT_MODEL) stt.model = e.BRIDGE_STT_MODEL.trim();
  if (e.BRIDGE_STT_LANGUAGE) stt.language = e.BRIDGE_STT_LANGUAGE.trim();
  if (e.BRIDGE_STT_API_KEY) stt.apiKey = e.BRIDGE_STT_API_KEY.trim();
  if (e.BRIDGE_STT_BASE_URL) stt.baseUrl = e.BRIDGE_STT_BASE_URL.trim();
  if (e.BRIDGE_STT_LOCAL_BIN) stt.localBin = e.BRIDGE_STT_LOCAL_BIN.trim();

  if (e.BRIDGE_NTFY_TOPIC || e.BRIDGE_NTFY_PRIORITY || e.BRIDGE_NTFY_SERVER) {
    cfg.notify = { ...(cfg.notify ?? {}) };
    if (e.BRIDGE_NTFY_TOPIC) cfg.notify.topic = e.BRIDGE_NTFY_TOPIC.trim();
    if (e.BRIDGE_NTFY_SERVER) cfg.notify.server = e.BRIDGE_NTFY_SERVER.trim();
    if (e.BRIDGE_NTFY_PRIORITY) {
      const pr = Number(e.BRIDGE_NTFY_PRIORITY);
      if (Number.isFinite(pr)) cfg.notify.priority = pr;
    } else if (e.BRIDGE_NTFY_TOPIC && !(Number(cfg.notify.priority) >= 1)) {
      // Supplying a topic via env implies "turn it on"; use a gentle default if not set.
      cfg.notify.priority = 3;
    }
  }
}

export function saveConfig(cfg: BridgeConfig): void {
  ensureRuntimeDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.chmodSync(CONFIG_PATH, 0o600);
}

/** Resolve a secret from an explicit value or a command (e.g. `gh auth token`). */
export function resolveSecret(explicit?: string, command?: string): string {
  if (explicit && explicit.trim()) return explicit.trim();
  if (command && command.trim()) {
    try {
      return execSync(command, { encoding: "utf8" }).trim();
    } catch (e: any) {
      throw new Error(`Failed to resolve secret via command "${command}": ${e?.message ?? e}`);
    }
  }
  return "";
}
