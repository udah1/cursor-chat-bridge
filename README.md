<div align="center">

# 🌉 cursor-chat-bridge <sub><sup>(Telegram, Discord, GitHub)</sup></sub>

### Drive the **Cursor** agent from your phone — over Telegram, Discord, or GitHub.

Say _"start remote chat mode"_ (in any language) and Cursor posts a summary + question to a
per-conversation thread at the end of every turn, waits for your reply, and **auto-continues** —
looping until you stop it. Step away from the keyboard; keep shipping from your phone.

[![npm version](https://img.shields.io/npm/v/cursor-telegram-chat?style=for-the-badge&color=cb3837&logo=npm)](https://www.npmjs.com/package/cursor-telegram-chat)
[![GitHub stars](https://img.shields.io/github/stars/udah1/cursor-chat-bridge?style=for-the-badge&logo=github&color=f5c518)](https://github.com/udah1/cursor-chat-bridge/stargazers)
[![license](https://img.shields.io/npm/l/cursor-telegram-chat?style=for-the-badge&color=blue)](./LICENSE)
[![Made for Cursor](https://img.shields.io/badge/built%20for-Cursor-000000?style=for-the-badge)](https://cursor.com)

[![npm downloads](https://img.shields.io/npm/dm/cursor-telegram-chat?color=cb3837&logo=npm)](https://www.npmjs.com/package/cursor-telegram-chat)
[![node](https://img.shields.io/node/v/cursor-telegram-chat?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![CI](https://img.shields.io/github/actions/workflow/status/udah1/cursor-chat-bridge/publish.yml?branch=master&logo=githubactions&logoColor=white&label=publish)](https://github.com/udah1/cursor-chat-bridge/actions/workflows/publish.yml)

<img src="docs/architecture.png" alt="cursor-chat-bridge round-trip flow" width="760">

<br/>

<table>
  <tr>
    <td align="center" width="50%">
      <img src="docs/screenshot-channels.png" alt="A channel per session in the chat app" width="280"><br/>
      <sub><b>A channel per session</b> — one per Cursor conversation</sub>
    </td>
    <td align="center" width="50%">
      <img src="docs/screenshot-session.png" alt="The agent posts summaries you reply to from your phone" width="280"><br/>
      <sub><b>Reply from your phone</b> — the agent picks up where it left off</sub>
    </td>
  </tr>
</table>

<br/>

<a href="https://youtu.be/MYDUyqirx2c">
  <img src="https://img.youtube.com/vi/MYDUyqirx2c/maxresdefault.jpg" alt="Watch the cursor-chat-bridge demo on YouTube" width="640">
</a>
<br/>
<sub>▶ <b>Watch the demo</b> (YouTube)</sub>

</div>

---

## Table of contents

- [Why](#why)
- [Features](#features)
- [Channels at a glance](#channels-at-a-glance)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Image attachments](#image-attachments)
- [Voice messages (speech-to-text)](#voice-messages-speech-to-text)
- [Configuration](#configuration)
- [Environment overrides](#environment-overrides)
- [The wait loop](#the-wait-loop-stop-hook)
- [Push notifications (ntfy)](#push-notifications-ntfy)
- [Per-platform setup](#per-platform-setup)
- [Writing a new adapter](#writing-a-new-adapter)
- [Security](#security)
- [Verification status](#verification-status)
- [Contributing](#contributing)
- [License](#license)

---

## Why

You kick off a task in Cursor, then need to leave your desk. Normally the agent stalls the moment
it needs a decision. **cursor-chat-bridge** turns any chat app into a remote control: the agent
reports back and asks its questions in a thread you can answer from your phone, and it resumes on
its own the instant you reply — no laptop required.

- **A thread per conversation.** Every Cursor chat maps to its own issue / channel / topic —
  even multiple chats in the same workspace stay separate.
- **Hands-free loop.** Replies are re-injected automatically; you don't touch Cursor to continue.
- **Pluggable channels.** Telegram, Discord, and GitHub Issues today — add your own in ~100 lines.
- **Safe by default.** Remote replies are treated as untrusted; destructive actions require an
  explicit confirmation sent back through the thread.
- **Proxy-friendly.** GitHub and Discord tunnel through TLS-intercepting corporate proxies.

## Features

| Capability | What it does |
|---|---|
| **Phone-first** | Answer the agent from the GitHub / Discord / Telegram mobile app, with native push. |
| **Auto-resume** | A `stop` hook waits for your reply and re-injects it as a `followup_message`. |
| **Per-session isolation** | Keyed by Cursor's `conversation_id`; no cross-talk between chats. |
| **Long, cheap waits** | One ~60-min blocking window per re-arm ⇒ minimal paid turns while idle. |
| **Off when you type** | A `beforeSubmitPrompt` hook disables the loop the moment you type in Cursor. |
| **Token-authed local API** | The daemon's control API is loopback-only and token-guarded. |
| **Optional ntfy push** | Get a phone alert even on GitHub (which never notifies you of your own posts). |
| **Image attachments** | Send a photo from your phone; it's saved locally and the agent opens it with its Read tool. |
| **Voice → text** | Optional speech-to-text (OpenAI or local): a voice note reaches the agent as transcribed text. |
| **Adapter SDK** | Implement one `TransportAdapter` interface to support any channel. |
| **Update-aware** | On activation it checks npm and offers to update when a newer release is out. |

## Channels at a glance

| Adapter | Status | Model | Mobile push |
|---|---|---|---|
| **Telegram** _(default)_ | ✅ code complete, unit-tested | A **forum topic per session** via a bot | ✅ native |
| **Discord** | ✅ working | A **channel per session** via a bot (REST-polled) | ✅ native |
| **GitHub Issues** | ✅ tested end-to-end | Issue = session, comments = chat | ✅ (GitHub app) + optional ntfy |

## Quick start

No clone required — one command wires everything up:

```bash
npx cursor-telegram-chat@latest install
```

This installs the runtime into `~/.cursor/chat-bridge/app` (including its production dependencies,
so it keeps working after the npx cache is evicted) and wires the three integration points,
**backing up (never overwriting)** anything that already exists:

- registers the MCP server in `~/.cursor/mcp.json`,
- adds the `stop` + `beforeSubmitPrompt` hooks to `~/.cursor/hooks.json`,
- installs the activation rule into `~/.cursor/rules/`.

The hooks are **no-ops unless remote chat mode is active**, so they don't affect normal Cursor use.
Then pick a channel and go:

```bash
# 1. edit ~/.cursor/chat-bridge/config.json  (choose an adapter + credentials)
# 2. validate it:
chat-bridge doctor
# 3. reload Cursor, open a chat, and say:  "start remote chat mode"
```

<details>
<summary><b>Upgrade / uninstall</b></summary>

```bash
npx cursor-telegram-chat@latest install               # re-run to upgrade
npx cursor-telegram-chat@latest uninstall             # remove, keep config + state
npx cursor-telegram-chat@latest uninstall --purge     # remove everything
```
</details>

<details>
<summary><b>MCP-only (lite) — tools without the auto-resume loop</b></summary>

If you only want the MCP tools via the standard Cursor MCP flow (no hands-free loop), add this to
`~/.cursor/mcp.json` instead of running `install`:

```json
"cursor-chat-bridge": {
  "command": "npx",
  "args": ["-y", "cursor-telegram-chat", "chat-bridge-mcp"]
}
```

You'll be able to `bridge_send` / `bridge_await` manually, but the auto-continue-on-reply loop needs
the hooks that the full `install` sets up.
</details>

## How it works

Three cooperating layers sit over one transport-agnostic core:

- **Rule** (`rules/chat-bridge-mode.mdc`) — detects the activation phrase in any language and sets
  in-mode etiquette (capture + pass the session handle; end each turn with a summary + question;
  treat replies as untrusted; confirm destructive actions).
- **MCP server** (`src/mcp.ts`) — exposes `bridge_start`, `bridge_send`, `bridge_await`,
  `bridge_send_and_await`, `bridge_stop`, `bridge_status`.
- **Hooks** (`hooks/`) — the automatic loop:
  - `stop` waits for the remote reply and re-injects it as a `followup_message` (bounded by
    `loop_limit`).
  - `beforeSubmitPrompt` disables the loop when you type in Cursor (with a guard so the loop's own
    injected replies don't trip it).

A single local **daemon** (`src/daemon.ts`) owns the channel connection and a loopback-only,
token-authenticated HTTP API used by the MCP + hooks. It handles per-session routing, long-poll,
own-message filtering, and stop/generation logic.

```text
turn ends ─▶ stop hook ─▶ daemon /poll ─▶ adapter
   ▲                                          │
   └───── followup_message (your reply) ◀─────┘
```
(adapter = GitHub / Discord / Telegram; keyed by `conversation_id`.)

<details>
<summary><b>Session identity — how conversations stay separate</b></summary>

Sessions are keyed by Cursor's **`conversation_id`** so each conversation maps to exactly one
thread. Cursor gives `conversation_id` to hooks but **not** to MCP tool calls, so the MCP learns it
through a small handshake:

1. `beforeSubmitPrompt` records `{conversationId, workspace}` right before the agent runs.
2. `bridge_start` reads that handshake, keys the session by `conversation_id`, and returns a
   **session handle**.
3. The agent passes `session=<handle>` on every subsequent `bridge_*` call — the reliable signal
   that keeps **two conversations in the same workspace** on separate threads.
4. Fallbacks if no handle is passed: in-process cache → per-workspace pointer
   (`BRIDGE_WORKSPACE`) → most recent submit.

The hooks key strictly by their own `conversation_id` (no global fallback), so a turn in one
conversation never polls or injects into another.
</details>

<details>
<summary><b>Troubleshooting: the session stops after a few minutes</b></summary>

The hands-free wait (default **60 min**) comes from the `stop` hook's re-arm loop, **not** from
`bridge_await` (which only polls ~50s per call). Cursor kills a `stop` hook after a short,
undocumented ceiling unless `~/.cursor/hooks.json` sets a large `timeout` — the installer sets
`timeout: 3660`. If your session stops after a couple of minutes:

1. **Using the MCP-only (lite) setup?** It has no hooks, so there's no auto-resume. Run the full
   `npx cursor-telegram-chat@latest install`.
2. **Fully quit and reopen Cursor** after installing — a reload doesn't always reload `hooks.json`.
3. Confirm `~/.cursor/hooks.json` has a `stop` hook with `timeout: 3660` (re-running the latest
   `install` fixes an older one).
4. Still killed early on your Cursor build? Shrink each wait window so it re-arms sooner: set
   `"stopWindowMin": 5` in `~/.cursor/chat-bridge/config.json` (the 60-min total is `stopBudgetMin`).
</details>

## Image attachments

Send a photo (or an image file) in the chat thread and the agent can see it:

1. The adapter captures the attachment on the message (Discord `attachments`, Telegram `photo` /
   image `document`).
2. The daemon downloads the bytes to `~/.cursor/chat-bridge/media/<session>/` and appends a note to
   the message text with the local path.
3. The agent opens that path with its **Read** tool — so the image reaches the model as vision input.

> **Behind a corporate TLS proxy:** Discord's `cdn.discordapp.com` is often blocked while
> `media.discordapp.net` is allowed. The Discord adapter automatically rewrites attachment URLs to
> the `media` host, so downloads work on such networks.

## Voice messages (speech-to-text)

Send a **voice note** (Telegram) or an **audio attachment** (Discord) and the agent receives a text
transcription as if you'd typed it — **off by default**. Enable it under `stt` in the config:

```jsonc
"stt": {
  "enabled": true,
  "provider": "openai",   // "openai" (OpenAI-compatible via baseUrl) or "local"
  "apiKeyCommand": "…",   // or "apiKey", or env BRIDGE_STT_API_KEY
  "language": "auto",     // auto-detect, or force "he" / "en"
  "keepAudio": true       // false = delete the audio after transcribing
}
```

- **`local` provider** (offline, recommended for sensitive audio): set `localBin`/`localArgs` to a CLI
  that prints the transcript to stdout (e.g. `whisper.cpp`). On a **corporate network** (`caCertPath`
  set), the default provider automatically flips to `local` so audio isn't sent off-host unless you
  explicitly choose a cloud provider.
- Transcription runs **asynchronously** in the daemon (never blocks the poll window); the transcript
  is delivered on the next reply cycle. See [`docs/stt-plan.md`](docs/stt-plan.md) for the full design.

## Configuration

`~/.cursor/chat-bridge/config.json`:

```jsonc
{
  "activeAdapter": "telegram",
  "pollIntervalMs": 60000,   // check for replies every N ms (min 10000)
  "minPollIntervalMs": 10000,
  "stopBudgetMin": 60,       // wait budget (mins); resets on every reply
  "stopWindowMin": 60,       // mins per window (keep < hooks.json timeout)
  "caCertPath": "",          // corporate CA bundle (PEM) if behind a TLS proxy
  "requireConfirmForDestructive": true,
  "adapters": {
    "github": {
      "owner": "you",
      "repo": "cursor-bridge-inbox",
      "tokenCommand": "gh auth token --user you"
    },
    "discord":  { "botToken": "", "channelId": "", "allowedUserIds": [] },
    "telegram": { "botToken": "", "chatId": "", "allowedUserIds": [] }
  }
}
```

> `caCertPath` is usually empty — leave it unless things fail. Some corporate networks intercept
> HTTPS with their own root cert that Node doesn't trust, so requests fail with `TypeError: fetch
> failed` while `curl` works. If you hit that, point `caCertPath` (or `BRIDGE_CA_CERT`) at your
> machine's CA bundle (PEM); `doctor`, the daemon, and the update check all honor it.
>
> ntfy push is **off by default** and isn't part of this file — enable it only via `BRIDGE_NTFY_*`
> env vars (see below).

## Environment overrides

Set these in the `env` block of the `cursor-chat-bridge` entry in `~/.cursor/mcp.json` (or the
shell) to override `config.json` without editing it. All namespaced `BRIDGE_*`. A change needs a
daemon restart (`chat-bridge shutdown`) to affect a running daemon.

| Env var | Overrides | Example |
|---|---|---|
| <sub><code>BRIDGE_PLATFORM</code></sub> | `activeAdapter` | `github` \| `telegram` \| `discord` |
| <sub><code>BRIDGE_POLL_INTERVAL</code></sub> | poll interval (**seconds**) | `30` |
| <sub><code>BRIDGE_STOP_BUDGET_MIN</code></sub> | wait budget, mins; resets on reply&nbsp;¹ | `60` |
| <sub><code>BRIDGE_STOP_WINDOW_MIN</code></sub> | mins per blocking window&nbsp;² | `60` |
| <sub><code>BRIDGE_CA_CERT</code></sub> | `caCertPath` | `/path/to/ca.pem` |
| <sub><code>BRIDGE_GITHUB_REPO</code></sub> | github `owner/repo` | `you/inbox` |
| <sub><code>BRIDGE_GITHUB_TOKEN</code></sub> | github token | `gho_…` |
| <sub><code>BRIDGE_TELEGRAM_BOT_TOKEN</code></sub> | telegram bot token | — |
| <sub><code>BRIDGE_TELEGRAM_CHAT_ID</code></sub> | telegram forum group id | — |
| <sub><code>BRIDGE_TELEGRAM_ALLOWED_USER_IDS</code></sub> | whitelist (csv) | `123,456` |
| <sub><code>BRIDGE_DISCORD_BOT_TOKEN</code></sub> | discord bot token | — |
| <sub><code>BRIDGE_DISCORD_CHANNEL_ID</code></sub> | discord **channel** id&nbsp;³ | — |
| <sub><code>BRIDGE_DISCORD_ALLOWED_USER_IDS</code></sub> | whitelist (csv) | `123,456` |
| <sub><code>BRIDGE_WORKSPACE</code></sub> | per-window session key | `${workspaceFolder}` |
| <sub><code>BRIDGE_NTFY_TOPIC</code></sub> | enable ntfy + set topic | `cursor-bridge-…` |
| <sub><code>BRIDGE_NTFY_PRIORITY</code></sub> | push priority 0–5 (0 = off) | `2` |
| <sub><code>BRIDGE_NTFY_SERVER</code></sub> | ntfy server base URL | `https://ntfy.sh` |

<sub>¹ Also `stopBudgetMin` in `config.json` — the reliable knob, since the hook doesn't inherit the MCP entry's env.
² Also `stopWindowMin` in `config.json`. Keep below the `stop` hook `timeout` in `~/.cursor/hooks.json`.
³ Any existing text channel in your server; used to locate the server + category — a fresh channel is created per session alongside it (For example #General).</sub>

Per-conversation platform can also be chosen at runtime: say _"start remote chat in Telegram"_ and
the agent passes `bridge_start(adapter: "telegram")` for that conversation only.

## The wait loop (stop hook)

While remote mode is active, the `stop` hook blocks at the end of each turn waiting for your reply.
Two knobs control it:

- **`stopWindowMin`** (default **60**) — how long a single hook invocation blocks before it returns
  a silent keep-alive and re-arms. Cursor caps `stop`-hook runtime at the `timeout` in
  `~/.cursor/hooks.json` (default **3660s / 61 min**); probing showed no hidden cap below that, so
  one ~60-min window means just **one paid keep-alive turn per hour** while you're away.
- **`stopBudgetMin`** (default **60**) — the total time to keep waiting across re-arms. It **resets
  on every reply**, so it's really "keep waiting up to N minutes since your last message."

The loop ends when you reply, type in Cursor, send `stop` in the thread, or call `bridge_stop`.

## Push notifications (ntfy)

GitHub never notifies you about your **own** activity — and the agent posts as _you_ (self-mentions
and self-assignment don't notify either). So to get a phone alert on the GitHub channel without a
second account, cursor-chat-bridge can fire an out-of-band push via [ntfy](https://ntfy.sh) on
every summary. It's free, account-less, open-source, self-hostable, and deep-links to the issue.

It's **off by default**. Enable it via env on the MCP entry:

1. Install the **ntfy** app (iOS/Android) or use the web app.
2. Pick a long, unguessable topic (topics are public-by-obscurity) and **subscribe** to it.
3. Set `BRIDGE_NTFY_TOPIC=cursor-bridge-<random>` in the `env` block of the `cursor-chat-bridge`
   entry in `~/.cursor/mcp.json`.

`BRIDGE_NTFY_PRIORITY` is the on/off dial: **0 = off (default)**, 1=min … 5=max. A push is sent only
when priority ≥ 1 **and** a topic is set. Pushes are skipped for **Telegram** and **Discord**, which
already notify natively.

## Per-platform setup

<details>
<summary><b>Telegram</b> — default, best chat UX</summary>

1. Create a bot with **@BotFather** → bot token.
2. Create a group, enable **Topics**, add the bot as admin with _Manage Topics_.
3. Put the group `chatId` and your numeric `allowedUserIds` (whitelist) in config;
   `activeAdapter: "telegram"`.

Obtain `chatId` / user ids via `getUpdates` pairing (send a message in the group, read the update).
Requires the daemon to reach `api.telegram.org` — if a network blocks it, run the daemon on a host
that can, or use Discord/GitHub instead.
</details>

<details>
<summary><b>Discord</b> — phone-first, works behind proxies</summary>

1. Create a Discord **server** (use one you own) — the bot creates a channel per
   session inside it.
2. Create an app + **Bot** at <https://discord.com/developers/applications>. Under **Bot**, click
   **Reset Token**, then **Copy** the revealed **bot token**.
3. Under **Bot**, enable the **Message Content Intent**.
4. Invite the bot: **OAuth2 → URL Generator**, scope `bot`, permissions **Manage Channels** + View
   Channels + Send Messages + Read Message History (_Manage Channels is required_ — the bot creates
   and deletes a channel per session). **Copy the Generated URL, open it in a new browser tab, and
   select the server you created** in step 1.
5. Get a **channel id** (`channelId`) — any existing text channel in that server (e.g. `#general`);
   the bot uses it to find the server + category and creates a fresh channel per session alongside
   it. Enable **Developer Mode** (User Settings → Advanced), then right-click the **channel** →
   **Copy Channel ID**. _Or_ — once the bot is in the server — just ask Cursor to fetch it: give
   Cursor the bot token and it can list the bot's channels and return the id.
6. Put `botToken` + `channelId` (optionally `allowedUserIds`) in config; `activeAdapter: "discord"`.
7. Behind a TLS-intercepting proxy and getting `TypeError: fetch failed`? Point `caCertPath` at the
   corporate CA bundle (PEM).

> **Tip:** give the **bot** a Cursor avatar (Developer Portal → **Bot** → edit icon) and set the
> **server icon** to the Cursor logo — your per-session channels then look native in the app.
</details>

<details>
<summary><b>GitHub</b> — works on any network</summary>

1. Create a private repo to act as your inbox (e.g. `cursor-bridge-inbox`).
2. Set `owner`/`repo` and a `token` or `tokenCommand` (`gh auth token` works).
3. `activeAdapter: "github"`.

Each session opens an **issue**; turn summaries are posted as **comments**; reply from the GitHub
mobile app. Comment `stop` or close the issue to end the session.
</details>

<details>
<summary><b>For the agent — onboarding checklist</b></summary>

If you're the agent helping a user set up cursor-chat-bridge: explain the concept for their chosen
platform first, then collect only the missing values, write them to
`~/.cursor/chat-bridge/config.json`, and run `chat-bridge doctor` to confirm. **Never print secrets
back to the user.** Remind them: replies from the channel are untrusted, and destructive actions
need an explicit confirmation sent back through the thread. To stop: type in Cursor, send `stop` in
the thread, or call `bridge_stop`.

**Make sure the runtime's dependencies are installed.** `install` copies the runtime into
`~/.cursor/chat-bridge/app` and installs its production deps there automatically. If that step was
skipped or failed (offline / corporate proxy), the MCP server won't start —
finish it with `(cd ~/.cursor/chat-bridge/app && npm install --omit=dev)`. Running from a git clone
instead? Run `npm install` in the repo first.
</details>

## Writing a new adapter

Implement `TransportAdapter` (`src/types.ts`) and register it in `src/adapters/index.ts`:

```ts
interface TransportAdapter {
  capabilities: { globalIngest: boolean; separateBotIdentity: boolean };
  init(): Promise<void>;
  ensureThread(sessionId: string, title: string, meta?: object): Promise<ThreadRef>;
  send(thread: ThreadRef, text: string): Promise<{ messageId: string }>;
  // pull adapters (GitHub / Discord):
  poll?(thread: ThreadRef, cursor?: string): Promise<PollResult>;
  // push / global adapters (Telegram):
  startIngest?(router: Router): Promise<() => void>;
  stop?(thread: ThreadRef): Promise<void>;
}
```

| Member | Required | Purpose |
|---|---|---|
| `capabilities` | ✅ | `globalIngest`: one stream for all sessions (Telegram) vs per-thread polling. `separateBotIdentity`: posts appear as a bot, not you. |
| `init()` | ✅ | Validate credentials + connectivity. |
| `ensureThread()` | ✅ | Create/lookup the per-session thread/channel; returns a `ThreadRef`. |
| `send()` | ✅ | Post a message (handle the platform's length limits / chunking). |
| `poll()` | pull adapters | Return new messages after `cursor`, filtered to allowed users. |
| `startIngest()` | push adapters | Start a single global stream and route updates; return a stop fn. |
| `stop()` | optional | Clean up (e.g. Discord deletes its per-session channel). |

## Security

- The loopback control API is **token-authenticated** — only local processes with the token (the
  MCP + hooks) can drive the daemon.
- Inbound messages are filtered by an `allowedUserIds` whitelist (Telegram/Discord).
- Every remote reply is wrapped and marked **untrusted**; the rule forbids destructive actions
  without an explicit confirmation sent back through the thread.
- Tokens live in `~/.cursor/chat-bridge/config.json` (chmod 600) and are never committed. Prefer
  `tokenCommand` over a stored token where possible.

## Verification status

Verified end-to-end on-machine (no Cursor restart needed):

- **GitHub adapter** — create issue, send, poll, own-message filtering, `stop` keyword, close-detection.
- **Daemon** — token auth, long-poll, stop/generation, persistence.
- **MCP server** — all tools over a real stdio JSON-RPC handshake.
- **Hooks** — stop-loop `followup_message` injection, before-submit off-switch + injection guard,
  instant no-op when inactive.
- **Per-conversation routing** (`node scripts/e2e-conv.mjs`) — distinct conversations open distinct
  issues; two conversations in the same workspace stay separate; re-activating a stopped session
  opens a fresh thread; unconfigured channels return onboarding guidance.
- **Unit tests** — `npm test` (routing, store semantics, message filtering).

## Contributing

Issues and PRs welcome. Local dev:

```bash
npm install
npm run build        # tsc → dist/
npm run typecheck
npm test             # node --test
npm run dev:daemon   # run the daemon from source (tsx)
```

New channels are the easiest contribution — implement one `TransportAdapter` (see above).

## License

[MIT](./LICENSE)
