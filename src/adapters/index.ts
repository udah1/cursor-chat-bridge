import type { BridgeConfig } from "../config.js";
import type { TransportAdapter } from "../types.js";
import { GithubAdapter } from "./github.js";
import { TelegramAdapter } from "./telegram.js";
import { TeamsAdapter } from "./teams.js";

export function createAdapter(name: string, cfg: BridgeConfig, log: (m: string) => void): TransportAdapter {
  const aCfg = cfg.adapters?.[name] ?? {};
  switch (name) {
    case "github":
      return new GithubAdapter(aCfg, log);
    case "telegram":
      return new TelegramAdapter(aCfg, log);
    case "teams":
      return new TeamsAdapter(aCfg, log);
    default:
      throw new Error(`Unknown adapter "${name}". Available: github, telegram, teams.`);
  }
}

export const ADAPTER_NAMES = ["github", "telegram", "teams"] as const;
