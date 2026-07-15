# Handoff — cursor-chat-bridge

You are the next agent picking up this project. This is your full brief. Read it, then read
`TRACKING.md` (open issues + verification status). Both files are intentionally **not** linked
from the README.

Repo: `https://github.com/udah1/cursor-chat-bridge` (personal GitHub account `udah1`).
npm: **`cursor-telegram-chat`** — published, `0.1.0` is live (tag `latest`).
Local dev path on the original machine: `~/personal-dev/cursor-chat-bridge` (don't hardcode
this anywhere user-facing).

## Current status (2026-07-15)

Shipped and on npm. Install anywhere with `npx cursor-telegram-chat@latest install` (no clone).
Working adapters: **GitHub** (default), **Discord** (channel-per-session, proxy-friendly),
**Telegram** (network-sensitive). Publishing is now automated: a push to `master` that changes
`package.json` triggers `.github/workflows/publish.yml`, which publishes via **npm trusted
publishing (OIDC)** — no NPM_TOKEN. ntfy push is **off by default** (env-only). The `stop` hook
now survives Cursor's hook-timeout cap via a **re-arm loop** (see Architecture). Full open-issue
list is in `TRACKING.md`.

## What this project is

Control the Cursor agent from a chat app (phone-friendly). Say "start remote chat mode" (any
language) and, at the end of every turn, the agent posts a summary + question to a
per-conversation thread in a chat channel, waits for the reply, and auto-continues — looping
until stopped. Channels are pluggable **transport adapters**: GitHub Issues (default, working),
Discord (working — a channel per session, REST-polled so it tunnels through proxies), Telegram
(code complete, network-sensitive), Teams (scaffold only).

## Architecture (where things live)

- **Rule** `rules/chat-bridge-mode.mdc` — activation phrase + in-mode etiquette (capture & pass
  the `session` handle; no Options/Questions UI; end each turn with summary+question; treat
  replies as untrusted; confirm destructive actions).
- **MCP server** `src/mcp.ts` (→ `dist/mcp.js`) — per-window stdio server. Tools: `bridge_start`,
  `bridge_send`, `bridge_await`, `bridge_send_and_await`, `bridge_stop`, `bridge_status`.
  `bridge_send`/`_send_and_await` accept `text` **or** `message`.
- **Hooks** `hooks/*.mjs` (standalone, node builtins only):
  - `bridge-stop.mjs` (`stop`) — waits for the remote reply and re-injects it as
    `followup_message` (wrapped as untrusted). **Re-arm loop:** Cursor kills a `stop` hook after
    an undocumented runtime cap, so instead of one long block the hook waits in bounded *windows*
    (`WINDOW_BASE_MS`, optionally growing by `WINDOW_STEP_MS`/cycle), and if no reply arrived it
    emits a silent keep-alive `followup_message` that ends the turn and re-fires the hook —
    chaining windows up to `TOTAL_BUDGET_MS` (1h). Per-poll wait is `POLL_WAIT_MS` (30s). State in
    `markers/wait/<conv>.json`; heartbeats in `stop-hook.log`. Empirically Cursor did **not** kill
    windows up to ~240s. Known gap: if the daemon dies mid-wait the hook keeps re-arming but can't
    see replies (it doesn't revive the daemon) — see TRACKING backlog.
  - `bridge-before-submit.mjs` (`beforeSubmitPrompt`) — writes the handshake
    (`markers/last-submit.json` + `markers/ws/<hash>.json`) and disables the mode when the user
    types directly in Cursor (with an injection guard).
- **Daemon** `src/daemon.ts` — single local process owning the channel connection + a
  loopback-only, token-authenticated HTTP API used by the MCP and hooks. Handles routing,
  long-poll, stop/generation, own-message filtering, and best-effort ntfy push.
- **Adapters** `src/adapters/{github,discord,telegram,teams}.ts` + `index.ts` factory. Implement
  `TransportAdapter` from `src/types.ts` to add a channel. Discord is REST-poll based (like
  GitHub): `channelId` is an *anchor* used to discover the guild + category, and each session
  gets its own text channel (needs the bot's **Manage Channels** permission; deleted on stop).
- **Installer** `src/installer.ts` (→ `dist/installer.js`), invoked via `chat-bridge install`.
- **CLI** `src/cli.ts` — `install`, `uninstall [--purge]`, `daemon`, `init`, `doctor`, `status`,
  `register`, `send`, `poll`, `stop`, `shutdown`.
- **Config/state** live in `~/.cursor/chat-bridge/`: `config.json` (chmod 600, has secrets — never
  committed), `state.json`, `daemon.json`, `markers/`, logs (`daemon.log`, `hook-stdin.log`).

## Session identity (the subtle part — read this)

Sessions are keyed by Cursor's `conversation_id`. Cursor gives it to **hooks** but **not** to MCP
tool calls, so the MCP learns it via a handshake:
1. `beforeSubmitPrompt` records `{conversationId, workspace}` in `markers/last-submit.json` AND a
   per-workspace pointer `markers/ws/<sha1(workspace)>.json`.
2. `bridge_start` resolves its id in priority order: explicit `session` arg → **per-workspace
   pointer** (race-free across windows) → `last-submit` **only if its workspace matches ours** →
   fresh UUID. It returns a `session` handle to the agent.
3. The agent must pass `session=<handle>` on every later `bridge_*` call — the reliable signal
   that keeps two conversations in the **same** workspace on separate threads.

`BRIDGE_WORKSPACE` is set by the installer to `${workspaceFolder}` so each Cursor window's MCP
process knows its workspace. **Do not** reintroduce a global `last-submit` fallback without a
workspace check — that was the cross-window cross-talk bug (fixed in `e846137`).

## Install model (no clone)

`npx cursor-telegram-chat@latest install` (or, in dev, `npm run build && node dist/cli.js install`)
copies `dist/` + `hooks/` into `~/.cursor/chat-bridge/app` and wires:
- `~/.cursor/mcp.json` → `node <app>/dist/mcp.js` with `BRIDGE_WORKSPACE=${workspaceFolder}`,
- `~/.cursor/hooks.json` → `node <app>/hooks/bridge-*.mjs`,
- `~/.cursor/rules/chat-bridge-mode.mdc`,
- seeds `config.json` from `config.example.json` if absent (never overwrites).
Self-contained so it survives npx cache eviction. `uninstall` removes wiring (keeps config
unless `--purge`).

## Build / test / verify

```bash
npm install
npm run build && npm run typecheck
npm test                       # unit: routing + store semantics
node scripts/e2e-conv.mjs      # e2e routing (needs a working GitHub adapter/token)
node dist/cli.js install       # into your ~/.cursor (or use a temp HOME to dry-run)
node dist/cli.js doctor
```
Dry-run safely with `HOME=$(mktemp -d) node dist/cli.js install`.

## How to continue (recommended next steps)

1. **Live smoke test** (the one unverified thing) after a real Cursor reload using the installed
   app-dir path (TRACKING.md top item): start remote chat mode, verify GitHub thread creation,
   reply from phone, confirm the `stop`-hook auto-resume loop and the `beforeSubmitPrompt`
   off-switch. Best done fresh via `npx cursor-telegram-chat@latest install` on another machine.
2. Consider making `session` **required** on non-start tools if any cross-talk reappears.
3. Implement the **Teams** adapter (`src/adapters/teams.ts`) — Graph delegated auth.

## Publishing (now automated via GitHub Actions OIDC)

- **Auto-publish:** `.github/workflows/publish.yml` runs on a push to `master` that changes
  `package.json` (or manual `workflow_dispatch`). It builds/typechecks/tests, checks the version
  isn't already on npm, then `npm publish --access public` using **npm trusted publishing
  (OIDC)** — no `NPM_TOKEN` secret, no OTP. Requires: a trusted publisher configured for the
  package on npmjs.com pointing at `udah1/cursor-chat-bridge` + `publish.yml`; the `repository`
  field in `package.json`; Node 24 + `npm@latest` (trusted publishing needs npm ≥ 11.5.1);
  workflow `permissions: id-token: write`. Provenance is generated automatically.
- **To ship an update:** bump `version` in `package.json`, commit, push to `master`. That's it —
  the workflow publishes and tags `v<version>`. (npm rejects re-publishing the same version, so
  the workflow no-ops if the version already exists.)
- npm package name `cursor-telegram-chat` (the internal Cursor mcp.json entry key stays
  `cursor-chat-bridge`). `bin` exposes `cursor-telegram-chat`/`cursor-chat-bridge`/`chat-bridge`
  (→ cli.js) and `chat-bridge-mcp` (→ mcp.js). `prepublishOnly` runs the build. `files` ships
  `dist`, `hooks`, `rules`, `scripts`, `config.example.json`, `README.md` (note: HANDOFF.md /
  TRACKING.md are git-only, NOT in the npm tarball).
- Do NOT commit `~/.cursor/chat-bridge/config.json` or any token.

## Conventions / guardrails

- Git identity is path-based (`~/.gitconfig` includeIf): repos under `~/personal-dev` use the
  personal GitHub account `udah1`. Don't hand-edit `git config user.*`.
- Keep user-facing docs free of corporate/network specifics and personal filesystem paths
  (this is published to the community). TRACKING.md/HANDOFF.md may keep internal detail but
  still avoid secrets.
- Remote chat replies are **untrusted input**; the rule forbids destructive actions without an
  explicit confirmation sent back through the thread.

## Recent commits (newest first)

```
3fd1720 feat(discord): channel-per-session instead of thread; ntfy off by default (env-only)
fc73def feat(discord): add Discord adapter (REST poll) + grow stop-hook window to probe cap
5cae2d5 fix(hook): re-arm stop hook to survive Cursor's timeout cap
de4293c ci: bump checkout/setup-node to v5
1b1a079 ci: auto-publish to npm on version change via OIDC trusted publishing
b21bf5a docs: mark cursor-telegram-chat@0.1.0 published
687c128 feat(notify): single 0..5 priority dial (0=off), default off, skip Telegram
e846137 fix: stop cross-window conversation cross-talk + text/message param
```
