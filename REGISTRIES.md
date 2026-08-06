# MCP registry / directory submissions

Playbook for listing **cursor-chat-bridge** across the MCP discovery ecosystem so AI agents and
humans can find it. Not linked from the README; internal working notes.

Canonical facts (reuse verbatim in every form):

- **Display name:** `cursor-chat-bridge`
- **GitHub repo:** `https://github.com/udah1/cursor-chat-bridge` (owner/repo = `udah1/cursor-chat-bridge`)
- **npm package:** `cursor-telegram-chat` — install/run `npx cursor-telegram-chat@latest install`
- **MCP stdio entry:** bin `chat-bridge-mcp` → `dist/mcp.js` (responds to `tools/list` with the `bridge_*` tools even with no daemon)
- **License:** MIT · **Language:** TypeScript · **Scope:** local (stdio)
- **Official-registry name:** `io.github.udah1/cursor-chat-bridge`
- **Tagline:** Drive the Cursor agent from Telegram, Discord, or GitHub — image attachments + voice notes transcribed to text.
- **Description:** Control the Cursor AI agent from a chat app. Say "start remote chat mode" and Cursor posts a per-conversation summary + question to a chat thread at the end of every turn, waits for your reply, and auto-continues. Pluggable transport adapters (Telegram / Discord / GitHub Issues) + a local daemon + MCP tools + hooks.

Order matters: **Glama first** (awesome-mcp-servers now requires a Glama listing + score), and the
**Official MCP Registry** auto-propagates to PulseMCP + Glama + VS Code.

---

## 1. Glama (highest priority — this is what AI agents read)

Listing, claiming, and *releasing* are three different things on Glama.

- **Listed** — automatic (Glama ingests the Official MCP Registry, see §2). ✅
- **Claimed** — `glama.json` at repo root (`maintainers: ["udah1"]`) + GitHub OAuth. ✅
- **Released** — NOT the same as a GitHub release, and NOT covered by the Official Registry.
  A Glama release is a *containerized build* Glama runs security scans against, and it is what
  earns the **A quality grade** (and what `awesome-mcp-servers` requires).

  **Glama ignores the repo's `Dockerfile`.** It generates its own from the form at
  <https://glama.ai/mcp/servers/udah1/cursor-chat-bridge/admin/dockerfile> — that generated file
  does `git clone` + `git checkout <sha>`, then runs your build steps and CMD. So the build spec
  below is the only thing that matters; the repo `Dockerfile` is just for local/self-hosting.

  Values that make the build test pass:

  | Field | Value |
  | --- | --- |
  | Build steps | `["npm ci", "npm run build"]` (repo ships `package-lock.json`, not a pnpm lockfile) |
  | CMD arguments | `["mcp-proxy", "--", "node", "dist/mcp.js"]` |
  | Placeholder parameters | `{}` — the server needs no config to answer `tools/list` |
  | Pinned commit SHA | empty, so builds track the latest commit |

  **The CMD is the one that bites:** `dist/cli.js` is the CLI — it prints usage and exits 0, so a
  container pointed at it dies before `mcp-proxy` can introspect anything, and the test fails with
  the server never coming up. The MCP server is `dist/mcp.js` (bin `chat-bridge-mcp`).

  Also: Glama builds the commit *it* last synced, which lags GitHub. If the page shows an old
  "Current head commit", click **sync** next to it before deploying.

  Then: **Deploy** → build test → when green, **Make Release** → version → **Create & Publish**.
  Re-run the same flow to update a release (the new one replaces the old).
- Once scored, the README badge populates: `https://glama.ai/mcp/servers/udah1/cursor-chat-bridge`

## 2. Official MCP Registry (auto-propagates to PulseMCP, Glama, VS Code)

> **Automated.** `.github/workflows/publish.yml` publishes to the registry after every npm
> release, using `mcp-publisher login github-oidc` (same OIDC identity as the npm publish, no
> secrets). It stamps `server.json` with the released version, so the registry never drifts
> behind npm. The steps below are only needed for a manual/first-time publish.
>
> Propagation gets you *listed* on Glama; it does not create a Glama **release** (see §1).

1. Add to `package.json`: `"mcpName": "io.github.udah1/cursor-chat-bridge"` (already done if present).
2. Generate the manifest: `npx @modelcontextprotocol/mcp-publisher init` → produces `server.json`
   (name MUST equal the `mcpName`; npm package `cursor-telegram-chat`; transport `stdio`).
3. Authenticate: `npx @modelcontextprotocol/mcp-publisher login github` (opens browser / device code — **needs you**).
4. Publish: `npx @modelcontextprotocol/mcp-publisher publish`.
5. Verify via the registry API by searching for `io.github.udah1/cursor-chat-bridge`.

## 3. awesome-mcp-servers (PR — do AFTER Glama score exists)

```bash
gh repo fork punkpeye/awesome-mcp-servers --clone
cd awesome-mcp-servers && git checkout -b add-cursor-chat-bridge
```

Add under the **Communication** (or Developer-Tools) category, alphabetical order:

```markdown
- [udah1/cursor-chat-bridge](https://github.com/udah1/cursor-chat-bridge) [![udah1/cursor-chat-bridge MCP server](https://glama.ai/mcp/servers/udah1/cursor-chat-bridge/badges/score.svg)](https://glama.ai/mcp/servers/udah1/cursor-chat-bridge) 📇 🏠 - Drive the Cursor agent from Telegram/Discord/GitHub: end-of-turn summaries + replies, image attachments, and voice notes transcribed to text.
```

(📇 = TypeScript, 🏠 = local. Full `owner/repo` name is required; PRs without the Glama badge are closed.)

## 4. mcp.so (manual form — Cloudflare-protected)

- <https://mcp.so/submit> → Repository URL `https://github.com/udah1/cursor-chat-bridge`,
  Server type **Local (stdio)**, description = tagline above. Review takes ~24–48h.

## 5. PulseMCP

- Auto-propagates ~1 week after the Official Registry publish (step 2). Otherwise submit the repo
  URL manually at <https://pulsemcp.com/submit>.

## 6. Smithery (optional / weak fit)

- Smithery expects Streamable-HTTP or an `.mcpb` bundle. This is a *local* stdio server that needs
  a running daemon + Cursor, so it doesn't fit URL-publishing. Skip unless we ship an `.mcpb` bundle.
