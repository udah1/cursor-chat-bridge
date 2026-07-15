import type { BridgeConfig } from "./config.js";

export interface ConfigCheck {
  ok: boolean;
  /** Agent-facing guidance: what to explain to the user, what to collect, and where to set it. */
  guidance?: string;
}

/**
 * Verify the active adapter has everything it needs. When something is missing, return
 * agent-facing guidance so the assistant can walk the user through setup interactively
 * instead of surfacing a raw error. Config path is `~/.cursor/chat-bridge/config.json`.
 */
export function checkAdapterConfig(adapter: string, cfg: BridgeConfig): ConfigCheck {
  const a: Record<string, any> = cfg.adapters?.[adapter] ?? {};

  if (adapter === "github") {
    const missing: string[] = [];
    if (!a.owner || !a.repo) missing.push("owner/repo (the private inbox repo)");
    if (!a.token && !a.tokenCommand) missing.push("a token (gh CLI or a PAT with `repo`/Issues:RW)");
    if (missing.length === 0) return { ok: true };
    return {
      ok: false,
      guidance:
        "GitHub channel isn't fully configured. Explain to the user: a private repo acts as the inbox; " +
        "each session opens an issue and they reply from the GitHub mobile app. Collect from the user and " +
        `set in config.adapters.github: ${missing.join("; ")}. ` +
        "Offer to create the repo (e.g. `gh repo create <name> --private`) and to use `gh auth token` if the " +
        "gh CLI is signed in. Then set activeAdapter to \"github\" and re-run bridge_start.",
    };
  }

  if (adapter === "telegram") {
    const missing: string[] = [];
    if (!a.botToken) missing.push("botToken (from @BotFather)");
    if (!a.chatId) missing.push("chatId (a forum-enabled supergroup where the bot is admin with Manage Topics)");
    if (!Array.isArray(a.allowedUserIds) || a.allowedUserIds.length === 0)
      missing.push("allowedUserIds (your numeric Telegram user id whitelist)");
    if (missing.length === 0) return { ok: true };
    return {
      ok: false,
      guidance:
        "Telegram channel isn't fully configured. Explain to the user: a bot posts to a forum topic per " +
        "session and they chat from the Telegram app (note: this only works where the daemon can reach " +
        "api.telegram.org — some corporate networks block it, requiring an off-box daemon). " +
        "Walk them through, step by step, and collect: " +
        `${missing.join("; ")}. Guide them: (1) create a bot with @BotFather to get botToken; (2) create a ` +
        "group, enable Topics, add the bot as admin with Manage Topics; (3) get the group chatId and their " +
        "numeric user id via getUpdates (have them send a message in the group, then read the update). " +
        "Set these in config.adapters.telegram, set activeAdapter to \"telegram\", then re-run bridge_start.",
    };
  }

  if (adapter === "teams") {
    return {
      ok: false,
      guidance:
        "Teams channel is not implemented yet (adapter is a scaffold). Explain to the user: it would post as " +
        "them via Microsoft Graph (delegated, no bot) and needs either an Azure AD app registration " +
        "(tenantId + clientId) or a one-time device-code sign-in, either of which the tenant may block. " +
        "For now, recommend using the GitHub channel instead.",
    };
  }

  return { ok: true };
}
