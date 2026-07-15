# Tracking — issues, TODO, verification

Internal working notes for cursor-chat-bridge. **Not linked from the README** on purpose.
Keep this honest and current; it's the shared memory across sessions/agents.

Legend: [ ] open · [x] done · [~] partial/in-progress

## Open issues / risks

- [ ] **Live end-to-end after a Cursor reload not yet re-confirmed for the npx install path.**
  The self-contained installer (`chat-bridge install`) is verified in an isolated `$HOME`
  (files land correctly), but a real Cursor window loading the MCP + hooks from
  `~/.cursor/chat-bridge/app` still needs a manual smoke test after reload.
- [ ] **Same-workspace, multi-conversation** relies on the agent passing the `session` handle
  on every `bridge_*` call. If the agent forgets, resolution falls back to the per-workspace
  pointer (correct for the *most recent* submit in that workspace) — good enough, but not
  bulletproof for two very-concurrent chats in one window. Consider making `session` required
  on non-start tools if we ever see cross-talk again.
- [ ] **Workspace = "none"** (a Cursor window with no folder open): `BRIDGE_WORKSPACE`
  resolves empty and we fall back to `process.cwd()` of the MCP process. Session keying is
  weaker in that edge case. Low priority.
- [ ] **stop-hook daemon self-heal** — if the daemon dies mid-wait, the hook keeps re-arming
  (cheap) but goes blind: it never revives the daemon, so replies are missed until something
  else (an MCP call) restarts it. Hook should detect `daemon-unreachable` and revive via the
  same spawn path `ensureDaemon` uses. Surfaced during the cap-probe when the daemon exited.
- [ ] **Finalize stop-hook window policy** — cap-probe showed Cursor did NOT kill windows up to
  ~240s (never hit a real kill; the run ended when the daemon died). Decide a steady value
  (fixed ~240s → ~15 re-arms/h vs 90s → ~40/h) or keep the growing probe. Defaults currently at
  probe values (`WINDOW_BASE_MS=240s`, `WINDOW_STEP_MS=180s`) — revert to a sane steady value.
- [ ] **Teams adapter is a scaffold** (`src/adapters/teams.ts`) — not usable yet. Needs Graph
  delegated auth (device-code / app registration) + implement ensureThread/send/poll.
- [ ] **Telegram not usable behind proxies** that block `api.telegram.org`. Code is complete
  and unit-tested; needs an off-box daemon to actually run in blocked environments.
- [x] **npm publish** — automated via `.github/workflows/publish.yml` (OIDC trusted publishing,
  no token). Push to `master` changing `package.json` publishes + tags. `cursor-telegram-chat`
  is live (account `udah1`). Bump `version` to release.

## Recently fixed

- [x] **Discord adapter** (`src/adapters/discord.ts`) — working. REST-polled (tunnels through
  TLS-intercepting proxies, unlike Telegram). Creates a **channel per session** in the server
  (anchor `channelId` → guild + category), deletes it on stop; needs the bot's **Manage
  Channels** permission + **Message Content Intent**. Unit-tested (`test/discord.test.ts`).
  (commits `fc73def`, `3fd1720`)
- [x] **stop-hook re-arm loop** — survives Cursor's undocumented hook-timeout cap by waiting in
  bounded windows and re-arming via a silent keep-alive `followup_message`, up to a 1h budget.
  Verified live (~45min / 27 cycles in v1). (commit `5cae2d5`)
- [x] **ntfy off by default, env-only** — removed the `notify` block from default/example config;
  enable only via `BRIDGE_NTFY_*`. Push now skipped for Discord too (native push). (commit `3fd1720`)
- [x] **Daemon TLS behind corporate proxy** — on a TLS-intercepting network Node's `fetch` fails
  (`TypeError: fetch failed`) while curl works; fix is `caCertPath` (→ `NODE_EXTRA_CA_CERTS` on
  the spawned daemon) pointing at the corporate CA bundle. Needed for Discord/GitHub at the office.
- [x] **Cross-window conversation cross-talk**: `bridge_start` used to learn its
  `conversation_id` from the global `last-submit.json`, which every Cursor window overwrites,
  so sessions collapsed onto one thread. Now it prefers the per-workspace pointer
  (`markers/ws/<hash>.json`) and only trusts `last-submit` when its workspace matches. (commit
  `e846137`)
- [x] **`message` vs `text` param**: agent guessed `message`; old code read empty `text` →
  GitHub `HTTP 422 Body cannot be blank`. Now accepts both, param named explicitly in tool
  descriptions/rule/`bridge_start` reply. (commit `e846137`)
- [x] **ntfy notification dial**: single `priority` 0..5 (0 = off, default off); a push is sent
  only when `priority >= 1` AND a topic is set; skipped for the Telegram and Discord adapters
  (native notifications). (commits `687c128`, `3fd1720`)
- [x] **Stale-stop**: re-activating a stopped session now resets stop state and opens a fresh
  thread instead of instantly returning `stopped`.
- [x] **Install without clone**: `chat-bridge install` / `uninstall` copy the runtime into
  `~/.cursor/chat-bridge/app` and wire mcp.json/hooks.json/rule → `npx cursor-chat-bridge install`.

## Verification status

Verified on-machine (no Cursor restart needed):
- `npm run build && npm run typecheck` — clean.
- `node scripts/e2e-conv.mjs` — all checks pass: distinct threads per conversation; two
  conversations in the same workspace stay separate via the session handle; re-activating a
  stopped session opens a fresh thread and does not instantly report `stopped`; unconfigured
  channels return onboarding guidance.
- `chat-bridge install` / `uninstall` into a temp `$HOME` — correct mcp.json/hooks.json/rule
  wiring, runtime copied, uninstall cleans up and keeps config unless `--purge`.
- ntfy reachability + priority dial (0=off … 5=max) verified against the built `dist/notify.js`.

Still needs a real Cursor reload + a live turn to confirm:
- Cursor resolves `${workspaceFolder}` per window for the global `~/.cursor/mcp.json` entry.
- Cursor honors `followup_message` + `loop_limit` on the `stop` hook, and `beforeSubmitPrompt`
  fires for user submits while the injected followup is caught by the guard.
- The full auto-resume loop over GitHub from a phone.

## Ideas / backlog

- [ ] Make `session` required on `bridge_send`/`bridge_await`/`bridge_send_and_await` if
  cross-talk ever recurs (turns silent misroute into a loud, self-correcting error).
- [ ] `chat-bridge doctor` could also validate the ntfy topic reachability and print the
  subscribe URL.
- [ ] Optional: publish an "Add to Cursor" deeplink for the MCP-only lite path.
- [ ] CI: run `npm test` + `e2e-conv` (the latter needs a GitHub token; gate on a secret).
