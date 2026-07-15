import { resolveSecret } from "../config.js";
import type { AdapterCapabilities, InboundMsg, PollResult, ThreadRef, TransportAdapter } from "../types.js";

const API = "https://api.github.com";

interface GithubAdapterConfig {
  owner: string;
  repo: string;
  token?: string;
  tokenCommand?: string;
}

export class GithubAdapter implements TransportAdapter {
  readonly name = "github";
  readonly capabilities: AdapterCapabilities = {
    globalIngest: false,
    separateBotIdentity: false, // agent posts as the same user, so own-message filtering is required
  };

  private token = "";
  constructor(private cfg: GithubAdapterConfig, private logFn: (m: string) => void) {}

  async init(): Promise<void> {
    if (!this.cfg.owner || !this.cfg.repo) {
      throw new Error("github adapter: 'owner' and 'repo' are required in config.adapters.github");
    }
    this.token = resolveSecret(this.cfg.token, this.cfg.tokenCommand);
    if (!this.token) {
      throw new Error("github adapter: no token (set adapters.github.token or tokenCommand)");
    }
    // Validate token + repo access.
    const r = await this.api(`/repos/${this.cfg.owner}/${this.cfg.repo}`);
    if (!r.ok) {
      throw new Error(`github adapter: cannot access ${this.cfg.owner}/${this.cfg.repo} (HTTP ${r.status})`);
    }
  }

  private async api(pathname: string, init?: RequestInit): Promise<Response> {
    return fetch(`${API}${pathname}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "cursor-chat-bridge",
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
  }

  async ensureThread(sessionId: string, title: string, meta?: Record<string, unknown>): Promise<ThreadRef> {
    const body =
      `**cursor-chat-bridge session** \`${sessionId}\`\n\n` +
      (meta?.cwd ? `📁 \`${meta.cwd}\`\n\n` : "") +
      `The agent will post turn summaries here. Reply in a comment to steer it. ` +
      `Comment \`stop\` (or close this issue) to end the session.`;
    const r = await this.api(`/repos/${this.cfg.owner}/${this.cfg.repo}/issues`, {
      method: "POST",
      body: JSON.stringify({ title: `🧵 ${title}`, body }),
    });
    if (!r.ok) throw new Error(`github ensureThread failed: HTTP ${r.status} ${await r.text()}`);
    const issue = (await r.json()) as { number: number };
    return { adapter: this.name, thread: String(issue.number), meta: { owner: this.cfg.owner, repo: this.cfg.repo } };
  }

  async send(thread: ThreadRef, text: string): Promise<{ messageId: string }> {
    const r = await this.api(
      `/repos/${this.cfg.owner}/${this.cfg.repo}/issues/${thread.thread}/comments`,
      { method: "POST", body: JSON.stringify({ body: text }) }
    );
    if (!r.ok) throw new Error(`github send failed: HTTP ${r.status} ${await r.text()}`);
    const c = (await r.json()) as { id: number };
    return { messageId: String(c.id) };
  }

  async poll(thread: ThreadRef, cursor: string | null): Promise<PollResult> {
    const sinceMs = cursor ? Number(cursor) : 0;
    const qs = cursor ? `?since=${new Date(sinceMs).toISOString()}&per_page=100` : `?per_page=100`;
    const r = await this.api(`/repos/${this.cfg.owner}/${this.cfg.repo}/issues/${thread.thread}/comments${qs}`);
    if (!r.ok) throw new Error(`github poll failed: HTTP ${r.status} ${await r.text()}`);
    const comments = (await r.json()) as Array<{
      id: number;
      body: string;
      created_at: string;
      user: { login: string; id: number };
    }>;

    let maxMs = sinceMs;
    const messages: InboundMsg[] = [];
    for (const c of comments) {
      const ts = new Date(c.created_at).getTime();
      if (ts > maxMs) maxMs = ts;
      if (ts <= sinceMs) continue; // already seen
      messages.push({ id: String(c.id), text: c.body, ts, authorId: String(c.user.id) });
    }

    // Detect an explicit stop: issue closed.
    let stopped = false;
    const issueRes = await this.api(`/repos/${this.cfg.owner}/${this.cfg.repo}/issues/${thread.thread}`);
    if (issueRes.ok) {
      const issue = (await issueRes.json()) as { state: string };
      if (issue.state === "closed") stopped = true;
    }

    return { messages, cursor: String(maxMs), stopped };
  }

  async stop(thread: ThreadRef): Promise<void> {
    await this.api(`/repos/${this.cfg.owner}/${this.cfg.repo}/issues/${thread.thread}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "closed", state_reason: "completed" }),
    }).catch(() => {});
  }
}
