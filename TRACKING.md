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
- [ ] **Teams adapter is a scaffold** (`src/adapters/teams.ts`) — not usable yet. Needs Graph
  delegated auth (device-code / app registration) + implement ensureThread/send/poll.
- [ ] **Telegram not usable behind proxies** that block `api.telegram.org`. Code is complete
  and unit-tested; needs an off-box daemon to actually run in blocked environments.
- [x] **npm publish** — `cursor-telegram-chat@0.1.0` is live (tag `latest`, account `udah1`).
  `npx cursor-telegram-chat@latest install` now resolves for everyone. Bump `version` before
  the next publish (npm won't accept a re-publish of the same version).

## Recently fixed

- [x] **Cross-window conversation cross-talk**: `bridge_start` used to learn its
  `conversation_id` from the global `last-submit.json`, which every Cursor window overwrites,
  so sessions collapsed onto one thread. Now it prefers the per-workspace pointer
  (`markers/ws/<hash>.json`) and only trusts `last-submit` when its workspace matches. (commit
  `e846137`)
- [x] **`message` vs `text` param**: agent guessed `message`; old code read empty `text` →
  GitHub `HTTP 422 Body cannot be blank`. Now accepts both, param named explicitly in tool
  descriptions/rule/`bridge_start` reply. (commit `e846137`)
- [x] **ntfy notification dial**: single `priority` 0..5 (0 = off, default off); a push is sent
  only when `priority >= 1` AND a topic is set; skipped entirely for the Telegram adapter
  (native notifications). (commit `687c128`)
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
