# Handoff — cursor-chat-bridge

You are the next agent picking up this project. This is your full brief. Read it, then read
`TRACKING.md` (open issues + verification status). Both files are intentionally **not** linked
from the README.

Repo: `https://github.com/udah1/cursor-chat-bridge` (personal GitHub account `udah1`).
Local dev path on the original machine: `~/personal-dev/cursor-chat-bridge` (don't hardcode
this anywhere user-facing).

## What this project is

Control the Cursor agent from a chat app (phone-friendly). Say "start remote chat mode" (any
language) and, at the end of every turn, the agent posts a summary + question to a
per-conversation thread in a chat channel, waits for the reply, and auto-continues — looping
until stopped. Channels are pluggable **transport adapters**: GitHub Issues (default, working),
Telegram (code complete, network-sensitive), Teams (scaffold only).

## Architecture (where things live)

- **Rule** `rules/chat-bridge-mode.mdc` — activation phrase + in-mode etiquette (capture & pass
  the `session` handle; no Options/Questions UI; end each turn with summary+question; treat
  replies as untrusted; confirm destructive actions).
- **MCP server** `src/mcp.ts` (→ `dist/mcp.js`) — per-window stdio server. Tools: `bridge_start`,
  `bridge_send`, `bridge_await`, `bridge_send_and_await`, `bridge_stop`, `bridge_status`.
  `bridge_send`/`_send_and_await` accept `text` **or** `message`.
- **Hooks** `hooks/*.mjs` (standalone, node builtins only):
  - `bridge-stop.mjs` (`stop`) — blocks for the remote reply, re-injects it as
    `followup_message` (wrapped as untrusted; bounded by `loop_limit`).
  - `bridge-before-submit.mjs` (`beforeSubmitPrompt`) — writes the handshake
    (`markers/last-submit.json` + `markers/ws/<hash>.json`) and disables the mode when the user
    types directly in Cursor (with an injection guard).
- **Daemon** `src/daemon.ts` — single local process owning the channel connection + a
  loopback-only, token-authenticated HTTP API used by the MCP and hooks. Handles routing,
  long-poll, stop/generation, own-message filtering, and best-effort ntfy push.
- **Adapters** `src/adapters/{github,telegram,teams}.ts` + `index.ts` factory. Implement
  `TransportAdapter` from `src/types.ts` to add a channel.
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

1. **Publish to npm** so `npx cursor-telegram-chat` resolves for everyone (see below).
2. **Live smoke test** after a real Cursor reload using the installed app-dir path (TRACKING.md
   top item): start remote chat mode, verify GitHub thread creation, reply from phone, confirm
   the `stop`-hook auto-resume loop and the `beforeSubmitPrompt` off-switch.
3. Consider making `session` **required** on non-start tools if any cross-talk reappears.
4. Implement the **Teams** adapter (`src/adapters/teams.ts`) — Graph delegated auth.

## Publishing

- npm package name `cursor-telegram-chat` (the internal Cursor mcp.json entry key stays
  `cursor-chat-bridge`). `bin` exposes `cursor-telegram-chat`/`cursor-chat-bridge`/`chat-bridge`
  (→ cli.js) and `chat-bridge-mcp` (→ mcp.js). `prepublishOnly` runs the build. `files` ships
  `dist`, `hooks`, `rules`, `scripts`, `config.example.json`, `README.md`.
- Steps: bump `version`, `npm login`, `npm publish --access public`. Then `npx
  cursor-telegram-chat@latest install` works anywhere.
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
687c128 feat(notify): single 0..5 priority dial (0=off), default off, skip Telegram
e846137 fix: stop cross-window conversation cross-talk + text/message param
359e556 notify: include thread id in push title
a0bfa28 Add ntfy push sidecar so you get phone alerts on GitHub
d69dde3 rule: handle bridge_send_and_await timeout gracefully
```
(This handoff + the npx installer + README sanitization are the next commit.)
