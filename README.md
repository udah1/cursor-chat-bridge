# cursor-chat-bridge

Control the **Cursor** AI agent from a chat app. Say *"start remote chat mode"* (in any
language) and the agent will, at the end of every turn, post a summary + question to a
per-conversation thread in your chat channel, wait for your reply, and continue — looping
until you stop it. Works from your phone. Each Cursor conversation gets its **own** thread,
even multiple conversations open in the same workspace.

Pluggable **transport adapters** mean the same machinery works over different channels:

| Adapter | Status | Notes |
|---|---|---|
| **GitHub Issues** | ✅ working, tested end-to-end | Issue = session, comments = chat. Great mobile app + push. Default. |
| **Telegram** | ✅ code complete, logic unit-tested | Forum topic per session via a bot. **Blocked by some corporate proxies** (see below) — run the daemon off-box in that case. |
| **Teams (Graph)** | 🚧 scaffold | Needs an Azure AD app (delegated `Chat.ReadWrite`). No bot required. |

> Why not just Telegram? On a machine behind Zscaler/Amdocs, `api.telegram.org` is
> blocked as a "suspicious URL" regardless of network (the endpoint agent tunnels even
> home Wi-Fi). GitHub / Microsoft Graph are corporate-sanctioned and reachable, so they
> are first-class channels here.

## How it works

Three cooperating layers over a transport-agnostic core:

- **Rule** (`rules/chat-bridge-mode.mdc`) — detects the activation phrase in any language
  and sets the in-mode etiquette (capture + pass the session handle; no Options UI; end each
  turn with a summary+question; treat replies as untrusted; confirm destructive actions).
- **MCP server** (`src/mcp.ts`) — per-window stdio server exposing `bridge_start`,
  `bridge_send`, `bridge_await`, `bridge_send_and_await`, `bridge_stop`, `bridge_status`.
- **Hooks** (`hooks/`) — the automatic loop:
  - `stop` waits for the remote reply and re-injects it as `followup_message` so the agent
    auto-continues (wrapped as *untrusted* input; bounded by `loop_limit`).
  - `beforeSubmitPrompt` disables bridge mode when you type directly in Cursor (with a guard
    so the loop's own injected replies don't trip it).

A single local **daemon** (`src/daemon.ts`) owns the channel connection and a loopback-only
HTTP API (token-authenticated) used by the MCP + hooks. It handles the single-consumer
Telegram `getUpdates` model, per-session routing, long-poll, and stop/generation logic.

### Session identity (how conversations stay separate)

Sessions are keyed by Cursor's **`conversation_id`** so each conversation maps to exactly one
chat thread. Cursor gives `conversation_id` to hooks but **not** to MCP tool calls, so the MCP
learns it through a small handshake and disambiguation chain:

1. `beforeSubmitPrompt` (fires right before the agent runs) records `{conversationId, workspace}`.
2. `bridge_start` reads that handshake, keys the session by `conversation_id`, and returns a
   **session handle** to the agent.
3. The agent passes `session=<handle>` on every subsequent `bridge_*` call — the fully reliable
   signal that keeps **two conversations in the same workspace** on separate threads.
4. Fallbacks if no handle is passed: in-process cache → per-workspace pointer
   (`BRIDGE_WORKSPACE=${workspaceFolder}`) → most recent submit.

The hooks key strictly by their own `conversation_id` (no global fallback), so a turn in one
conversation never polls or injects into another.

```
Cursor turn ends ──▶ stop hook (conversation_id) ──▶ daemon /poll (long) ──▶ adapter (GitHub/Telegram/Teams)
        ▲                                                    │
        └──────────── followup_message (reply) ◀─────────────┘
```

## Install

```bash
git clone <repo> ~/personal-dev/cursor-chat-bridge
cd ~/personal-dev/cursor-chat-bridge
./scripts/install.sh        # build + wire into ~/.cursor (backs up existing files)
# edit ~/.cursor/chat-bridge/config.json, then:
chat-bridge doctor          # validate the active adapter
# reload Cursor, then say "start remote chat mode" in a chat
```

`install.sh` merges (never overwrites) `~/.cursor/mcp.json` and `~/.cursor/hooks.json`,
and installs the rule. The hooks are **no-ops unless bridge mode is active**, so they don't
affect normal Cursor usage.

## Configuration

`~/.cursor/chat-bridge/config.json`:

```jsonc
{
  "activeAdapter": "github",
  "pollIntervalMs": 60000,      // how often to check for replies (min 10000)
  "minPollIntervalMs": 10000,
  "caCertPath": "", // usually leave empty. GitHub & MS Graph are not TLS-intercepted, so no CA is needed. Only set this (or use Node's --use-system-ca) for a Telegram daemon behind a TLS-intercepting proxy.
  "requireConfirmForDestructive": true,
  "adapters": {
    "github":  { "owner": "you", "repo": "cursor-bridge-inbox", "tokenCommand": "gh auth token --user you" },
    "telegram":{ "botToken": "", "chatId": "", "allowedUserIds": [] }
  }
}
```

### Env-var overrides (per MCP instance)

Set these in the `env` block of the `cursor-chat-bridge` entry in `~/.cursor/mcp.json`
(or the shell) to override `config.json` without editing it. Namespaced `BRIDGE_*`.
A change needs a daemon restart (`chat-bridge shutdown`) to affect a running daemon.

| Env var | Overrides | Example |
|---|---|---|
| `BRIDGE_PLATFORM` | `activeAdapter` | `github` \| `telegram` \| `teams` |
| `BRIDGE_POLL_INTERVAL` | poll interval, in **seconds** | `30` |
| `BRIDGE_CA_CERT` | `caCertPath` | `/Users/you/vercel-ca-bundle.pem` |
| `BRIDGE_GITHUB_REPO` | github `owner/repo` | `you/cursor-bridge-inbox` |
| `BRIDGE_GITHUB_TOKEN` | github token | `gho_…` |
| `BRIDGE_TELEGRAM_BOT_TOKEN` | telegram bot token | — |
| `BRIDGE_TELEGRAM_CHAT_ID` | telegram forum group id | — |
| `BRIDGE_TELEGRAM_ALLOWED_USER_IDS` | comma-separated whitelist | `123,456` |
| `BRIDGE_WORKSPACE` | workspace path for per-window session keying | set by the installer to `${workspaceFolder}` |
| `BRIDGE_NTFY_TOPIC` | enable ntfy push + set the topic | `cursor-bridge-ab12cd…` |
| `BRIDGE_NTFY_SERVER` | ntfy server base URL | `https://ntfy.sh` (default) |

`BRIDGE_WORKSPACE` is wired automatically by the installer to `${workspaceFolder}` so each
Cursor window keys its sessions to the open project; you normally don't set it by hand.

Per-conversation platform can also be chosen at runtime: say "start remote chat in Telegram"
and the agent passes `bridge_start(adapter: "telegram")` for that conversation only.

### Push notifications to your phone (ntfy)

Heads-up about GitHub: the agent posts **as you**, and GitHub never notifies you about your
own activity — **self @mentions and self-assignment don't notify either**. So to get a phone
alert without a second account, cursor-chat-bridge can fire an out-of-band push via
[ntfy](https://ntfy.sh) on every summary it posts. It's free, needs no account, is open-source
and self-hostable, and the push deep-links straight to the GitHub issue.

Setup:
1. Install the **ntfy** app (iOS/Android) or use the web app.
2. Pick a long, unguessable topic (topics are public-by-obscurity) and **subscribe** to it.
3. Configure it — either in `config.json`:

```jsonc
"notify": { "type": "ntfy", "server": "https://ntfy.sh", "topic": "cursor-bridge-<random>", "priority": 4 }
```

   or via env: `BRIDGE_NTFY_TOPIC=cursor-bridge-<random>`.

Now every turn summary pings your phone; you still read and reply inside the GitHub issue.
(ntfy.sh is reachable on networks that block Telegram/Pushover; you can also self-host and
point `server` at your own instance.)

### GitHub setup
1. Create a private repo to act as your inbox (e.g. `cursor-bridge-inbox`).
2. Set `owner`/`repo` and a `token` or `tokenCommand` (`gh auth token` works).

### Telegram setup (if reachable from where the daemon runs)
1. Create a bot with **@BotFather** → bot token.
2. Create a group, enable **Topics**, add the bot as admin with *Manage Topics*.
3. Put the group `chatId` and your `allowedUserIds` (whitelist) in config.

## For the agent (onboarding guide)

If you are the agent helping a user set up cursor-chat-bridge, walk them through
the checklist for their chosen platform. Explain the concept first, then collect only the
missing values, write them to `~/.cursor/chat-bridge/config.json`, and run `chat-bridge
doctor` to confirm. Never print secrets back to the user.

### GitHub (recommended — works on any network)
Explain: "A private repo acts as your inbox. Each Cursor session opens an **issue**; I post
turn summaries as **comments**; you reply from the GitHub mobile app (with push
notifications). Comment `stop` or close the issue to end the session."
Collect / do:
- A private repo to use as the inbox (`owner/repo`). Offer to create one (`cursor-bridge-inbox`).
- A token: prefer `gh auth token` (if the `gh` CLI is signed in), otherwise a Personal Access
  Token with `repo` scope.
- Set `adapters.github.owner`, `.repo`, and `.tokenCommand` (or `.token`). Set `activeAdapter: "github"`.

### Telegram (best chat UX, but network-sensitive)
Explain: "A Telegram **bot** posts to a **forum topic per session**; you chat from the
Telegram app. This only works where the daemon can reach `api.telegram.org` — some corporate
networks (e.g. Zscaler) block it, in which case run the daemon on an off-box host."
Collect / do:
- A **bot token** from **@BotFather**.
- A **forum-enabled supergroup**: create a group → enable Topics → add the bot as admin with
  *Manage Topics*.
- The group **chatId** and the user's numeric **user id(s)** for `allowedUserIds` (whitelist).
  Help obtain these via `getUpdates` pairing (send a message in the group, read the update).
- Set `adapters.telegram.botToken`, `.chatId`, `.allowedUserIds`. Set `activeAdapter: "telegram"`.

### Teams (Microsoft Graph, delegated — no bot)
Explain: "I post as **you** via Microsoft Graph (no bot needed); a chat/channel per session.
Requires either an Azure AD **app registration** or a one-time **device-code sign-in**
(tenant policy may block either)."
Collect / do:
- `tenantId`, and a `clientId` (your app registration) — or use device-code with a public client.
- A one-time interactive sign-in to cache a delegated token (scope `Chat.ReadWrite`).
- If the tenant blocks app registration and device-code, Teams is not usable; fall back to GitHub.
- (Adapter is currently a scaffold — implement `src/adapters/teams.ts` before first use.)

### All platforms
- Confirm reachability with `chat-bridge doctor`.
- Remind: replies from the channel are treated as untrusted; destructive actions need an
  explicit confirmation sent back through the thread.
- To stop: type in Cursor, send `stop` in the thread, or call `bridge_stop`.

## Writing a new adapter

Implement `TransportAdapter` (`src/types.ts`) and register it in `src/adapters/index.ts`:

```ts
interface TransportAdapter {
  capabilities: { globalIngest; separateBotIdentity };
  init(): Promise<void>;
  ensureThread(sessionId, title, meta?): Promise<ThreadRef>;
  send(thread, text): Promise<{ messageId }>;
  poll?(thread, cursor): Promise<PollResult>;        // pull adapters
  startIngest?(router): Promise<() => void>;         // push/global adapters
  stop?(thread): Promise<void>;
}
```

## Security

- Loopback API is **token-authenticated**; only local processes with the token (the MCP +
  hooks) can drive it.
- Telegram inbound is filtered by an `allowedUserIds` whitelist.
- Every remote reply is wrapped and marked **untrusted**; the rule forbids destructive
  actions without an explicit confirmation sent back through the thread.
- The bot/GitHub token lives in `~/.cursor/chat-bridge/config.json` (chmod 600) and is never
  committed. Prefer `tokenCommand` over a stored token where possible.

## Test / verification status

Verified end-to-end on-machine (no Cursor restart needed):
- GitHub adapter: create issue, send, poll, own-message filtering, `stop` keyword, close-detection.
- Daemon: token auth, long-poll, stop/generation, persistence.
- MCP server: all 6 tools over a real stdio JSON-RPC handshake.
- Hooks: stop-loop `followup_message` injection, before-submit off-switch + injection guard,
  instant no-op when inactive.
- **Per-conversation routing** (`npm run build && node scripts/e2e-conv.mjs`): different
  conversations open **distinct** issues; two conversations in the **same** workspace stay
  separate via the session handle; re-activating a stopped session opens a fresh thread and
  does not instantly report `stopped`; unconfigured channels return onboarding guidance.
- Unit tests: `npm test` (routing + store semantics).

Needs a Cursor reload + a real turn to confirm (payloads are logged to
`~/.cursor/chat-bridge/hook-stdin.log`, and the MCP logs the resolved workspace/conversation
to `~/.cursor/chat-bridge/daemon.log`):
- That Cursor resolves `${workspaceFolder}` per-window for a global `~/.cursor/mcp.json`.
- That Cursor honors `followup_message` + `loop_limit` on the `stop` hook, and that
  `beforeSubmitPrompt` fires for user submits while the injected followup is caught by the guard.

## License

MIT
