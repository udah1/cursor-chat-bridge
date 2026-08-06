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

- `glama.json` is committed at repo root (`maintainers: ["udah1"]`).
- Claim it: go to <https://glama.ai/mcp/servers> → **Add MCP Server** → repo URL
  `https://github.com/udah1/cursor-chat-bridge` → authenticate with GitHub (repo is under your
  personal account, so OAuth auto-associates you). Glama crawls + scores within ~24h.
- Once scored, the badge in the README populates:
  `https://glama.ai/mcp/servers/udah1/cursor-chat-bridge`

## 2. Official MCP Registry (auto-propagates to PulseMCP, Glama, VS Code)

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
