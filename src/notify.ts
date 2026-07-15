/**
 * Out-of-band push notifications, decoupled from the chat channel.
 *
 * Why: on GitHub, the agent posts as *you*, and GitHub never notifies you about your own
 * activity (self @mentions and self-assignment don't notify either). So to get a phone alert
 * we push through a separate service. ntfy.sh works well: free, no account, open-source and
 * self-hostable — subscribe to a private topic in the ntfy mobile app and every POST to
 * https://ntfy.sh/<topic> becomes a push. Topics are unguessable-by-obscurity, so use a long
 * random one. Best-effort: notification failures never block the chat flow.
 */
export interface NotifyConfig {
  /**
   * Single on/off + intensity dial for ntfy pushes, on the 0..5 scale:
   *   0 = OFF (no push), 1 = min, 2 = low, 3 = normal, 4 = high, 5 = max.
   * Defaults to 0 (off). A push is sent only when priority >= 1 AND a topic is set.
   */
  priority?: number | string;
  /** ntfy server base URL (default https://ntfy.sh). */
  server?: string;
  /** ntfy topic to publish to (also the string you subscribe to in the app). */
  topic?: string;
  /** @deprecated no longer used; enablement is driven by `priority` (0 = off). */
  type?: "none" | "ntfy";
}

/** Normalize the priority dial to an integer 0..5 (0 = disabled). */
export function notifyPriority(cfg: NotifyConfig | undefined): number {
  const raw = Number(cfg?.priority ?? 0);
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(5, Math.round(raw)));
}

/** Whether an ntfy push should be sent for this config. */
export function notifyEnabled(cfg: NotifyConfig | undefined): boolean {
  return !!cfg?.topic && notifyPriority(cfg) >= 1;
}

export interface NotifyPayload {
  title: string;
  message: string;
  /** Optional URL opened when the push is tapped (e.g. the GitHub issue). */
  clickUrl?: string;
}

/** Header values must be ISO-8859-1/ASCII-safe; strip anything else (the body keeps UTF-8). */
function headerSafe(s: string): string {
  return s.replace(/[^\x20-\x7E]/g, "").trim();
}

export async function pushNotify(
  cfg: NotifyConfig | undefined,
  payload: NotifyPayload,
  log?: (m: string) => void
): Promise<void> {
  if (!notifyEnabled(cfg)) return;
  const server = (cfg!.server || "https://ntfy.sh").replace(/\/+$/, "");
  const headers: Record<string, string> = {
    Title: headerSafe(payload.title || "cursor-chat-bridge").slice(0, 200) || "cursor-chat-bridge",
    Priority: String(notifyPriority(cfg)),
    Tags: "speech_balloon",
  };
  if (payload.clickUrl) headers.Click = payload.clickUrl;
  const body = (payload.message || "").slice(0, 1000);
  try {
    const r = await fetch(`${server}/${encodeURIComponent(cfg!.topic!)}`, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) log?.(`ntfy push failed: HTTP ${r.status}`);
  } catch (e: any) {
    log?.(`ntfy push error: ${e?.message ?? e}`);
  }
}
