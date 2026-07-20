#!/usr/bin/env node
import fs from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { daemonRequest } from "./daemonClient.js";
import { loadConfig, type BridgeConfig } from "./config.js";
import {
  readMarker,
  writeMarker,
  clearMarker,
  claimStartConversation,
  finalizeClaim,
  restoreClaim,
  resolveActiveConversation,
  legacyResolve,
} from "./markers.js";
import { checkAdapterConfig } from "./onboarding.js";
import { LOG_PATH, ensureRuntimeDir } from "./paths.js";
import { checkForUpdate, currentVersion, packageName } from "./version.js";

// Cursor resolves ${workspaceFolder} per window; falls back to cwd if not provided. Used only
// for the legacy upgrade-skew fallback and as a title/cwd default — NOT to key the session
// (which is claimed by the real conversation id, so misrouting can't bind the wrong workspace).
const WORKSPACE = process.env.BRIDGE_WORKSPACE || process.cwd();

const DEFAULT_FRESH_MS = 600000;

function handshakeFreshMs(cfg: BridgeConfig): number {
  const v = Number((cfg as any).handshakeFreshMs);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_FRESH_MS;
}

function debug(msg: string): void {
  try {
    ensureRuntimeDir();
    fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] [mcp] ${msg}\n`);
  } catch {}
}

function text(s: string) {
  return { content: [{ type: "text", text: s }] };
}

function updateNote(update: { current: string; latest?: string; updateAvailable: boolean }): string {
  return update.updateAvailable
    ? `\n\n⬆️ UPDATE AVAILABLE: ${update.current} → ${update.latest}. Before continuing, tell the user and ask ` +
        `(via the normal Cursor question UI — the remote loop hasn't started) whether to update now with ` +
        `\`npx ${packageName()}@latest install\` (then reload Cursor). If they decline, continue normally.`
    : "";
}

function startReply(adapter: string, thread: string | null | undefined, conversationId: string, extra: string): string {
  return (
    `remote chat mode ON via "${adapter}". Thread ${thread}. ` +
    `Your session handle is "${conversationId}". IMPORTANT: pass session="${conversationId}" to every ` +
    `subsequent bridge_* call so this conversation stays on its own thread. At the end of each turn send a ` +
    `summary + question with bridge_send_and_await (put the message in the "text" argument), act on the reply, ` +
    `and do not use the Options/Questions UI.` +
    extra
  );
}

/** Fail-closed guidance when bridge_start can't unambiguously identify the conversation. */
function failClosedMessage(reason: "empty" | "stale" | "ambiguous", freshMs: number): string {
  if (reason === "empty") {
    return (
      "remote chat mode: no submit handshake was found for this turn, so I can't bind this chat to its own " +
      "thread (I won't guess — that risks hijacking another chat's thread). This usually means the chat-bridge " +
      "hooks aren't installed or Cursor hasn't loaded them yet. Fix: run `npx " +
      packageName() +
      "@latest install`, then FULLY quit and reopen Cursor (not just reload), and say “start remote chat mode” again."
    );
  }
  if (reason === "stale") {
    return (
      "remote chat mode: the submit handshake for this turn was stale or already claimed, so I can't safely bind " +
      `this chat. Re-send your “start remote chat mode” message from THIS chat and call bridge_start again ` +
      `(handshakes are considered fresh for ${Math.round(freshMs / 1000)}s; raise config.handshakeFreshMs if needed).`
    );
  }
  return (
    "remote chat mode: more than one chat in this same project folder submitted at nearly the same moment, so I " +
    "can't tell which one to bind without risking crossing threads. Re-send “start remote chat mode” from just " +
    "THIS chat (wait a beat so it's the only pending submit in this folder) and call bridge_start again — I won't guess."
  );
}

const SESSION_ARG = {
  type: "string",
  description:
    "REQUIRED. The session handle returned by bridge_start for THIS conversation. Always pass it so the right chat " +
    "thread is used and multiple conversations (even in the same workspace) stay separate.",
};

const TEXT_ARG = { type: "string", description: "The message text to post to the chat thread." };

const TOOLS = [
  {
    name: "bridge_start",
    description:
      "Start remote chat mode for this conversation: opens a per-conversation thread/channel in the configured " +
      "chat channel (GitHub issue / Telegram topic / Discord channel) and routes end-of-turn summaries there. " +
      "Call this when the user asks to start remote chat / bridge / telegram mode (in any language). If the " +
      "channel isn't configured, this returns setup guidance — follow it to onboard the user, then call " +
      "bridge_start again.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description:
            "Session title — a concise (≤6-word) summary of THIS conversation's topic, mirroring how it appears " +
            "in Cursor's chat list (e.g. \"GitHub Actions autopublish\"). Names the thread/channel. Defaults to " +
            "the folder name if omitted.",
        },
        adapter: { type: "string", description: "Override the channel adapter (github|telegram|discord)." },
        session: {
          type: "string",
          description:
            "Optional. Only when RE-starting an existing session (idempotent re-arm) — pass the handle you got " +
            "from a previous bridge_start. Omit for a brand-new start.",
        },
      },
    },
  },
  {
    name: "bridge_send",
    description:
      "Post a message (e.g. a turn summary or a question) to this conversation's chat thread. Put the message in " +
      "the `text` argument (alias: `message`). Pass the `session` handle returned by bridge_start (required).",
    inputSchema: {
      type: "object",
      properties: { text: TEXT_ARG, message: TEXT_ARG, session: SESSION_ARG },
      required: ["session"],
    },
  },
  {
    name: "bridge_await",
    description:
      "Block waiting for the user's reply in the chat thread (single long-poll window). Returns the reply text, " +
      "or status 'timeout' (call again to keep waiting) or 'stopped' (mode ended). Pass the `session` handle from bridge_start (required).",
    inputSchema: {
      type: "object",
      properties: { maxBlockMs: { type: "number" }, session: SESSION_ARG },
      required: ["session"],
    },
  },
  {
    name: "bridge_send_and_await",
    description:
      "Post a message then block for the user's reply. Convenience for end-of-turn summary + question. Put the " +
      "message in the `text` argument (alias: `message`). Pass the `session` handle returned by bridge_start (required).",
    inputSchema: {
      type: "object",
      properties: { text: TEXT_ARG, message: TEXT_ARG, maxBlockMs: { type: "number" }, session: SESSION_ARG },
      required: ["session"],
    },
  },
  {
    name: "bridge_stop",
    description: "Stop remote chat mode for this conversation. Pass the `session` handle from bridge_start (required).",
    inputSchema: { type: "object", properties: { session: SESSION_ARG }, required: ["session"] },
  },
  {
    name: "bridge_status",
    description: "Show remote chat mode status for this conversation. Pass the `session` handle from bridge_start (required).",
    inputSchema: { type: "object", properties: { session: SESSION_ARG }, required: ["session"] },
  },
];

const server = new Server({ name: "cursor-chat-bridge", version: currentVersion() }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, any>;
  const cfg = loadConfig();

  try {
    if (name === "bridge_start") {
      const adapter = args.adapter || cfg.activeAdapter;

      // Onboard the user if the chosen channel isn't fully configured (no side effects).
      const check = checkAdapterConfig(adapter, cfg);
      if (!check.ok) return text(check.guidance ?? `Adapter "${adapter}" is not configured.`);

      // Best-effort "is there a newer release?" check, run in parallel so it adds no latency.
      const updatePromise = checkForUpdate().catch(
        () => ({ current: currentVersion(), latest: undefined, updateAvailable: false })
      );

      const now = Date.now();
      const freshMs = handshakeFreshMs(cfg);

      // (a) Explicit-session RE-start fast-path: idempotent re-arm of a known session, keeps its
      //     existing thread. Never consumes a pending claim.
      if (args.session) {
        const sid = String(args.session);
        const existing = readMarker(sid);
        if (existing) {
          const reAdapter = existing.adapter || adapter;
          const title = args.title || existing.workspace.split("/").pop() || "cursor-session";
          const r = await daemonRequest("POST", "/register", {
            sessionId: sid,
            title,
            cwd: existing.workspace,
            adapter: reAdapter,
          });
          writeMarker({
            ...existing,
            adapter: reAdapter,
            thread: r.thread?.thread ?? existing.thread,
            active: true,
            updatedAt: Date.now(),
          });
          const update = await updatePromise;
          return text(startReply(reAdapter, r.thread?.thread ?? existing.thread, sid, updateNote(update)));
        }
        // session given but unknown -> fall through to a fresh claim.
      }

      // (b) Claim the fresh pending record for THIS window's workspace by its REAL conversation id.
      let claim = claimStartConversation(now, freshMs, WORKSPACE);
      let legacy = false;
      if ("none" in claim && claim.none === "empty") {
        // Upgrade skew: an old hook that predates pending/ records. Bounded legacy fallback.
        const lr = legacyResolve(now, freshMs, WORKSPACE);
        if (lr) {
          claim = { conversationId: lr.conversationId, workspace: lr.workspace };
          legacy = true;
        }
      }
      if ("none" in claim) return text(failClosedMessage(claim.none, freshMs));

      const conversationId = claim.conversationId;
      const workspace = claim.workspace || WORKSPACE || "";
      const title = args.title || workspace.split("/").pop() || "cursor-session";
      debug(`bridge_start workspace=${workspace} conversationId=${conversationId} adapter=${adapter} legacy=${legacy}`);

      // (c) Register FIRST; only finalize the claim once the daemon accepted it, so a failed
      //     register leaves the pending record intact for a retry.
      let r;
      try {
        r = await daemonRequest("POST", "/register", { sessionId: conversationId, title, cwd: workspace, adapter });
      } catch (e: any) {
        if (!legacy) restoreClaim(conversationId);
        return text(`error: could not register remote session (${e?.message ?? e}). Please call bridge_start again.`);
      }
      if (!legacy) finalizeClaim(conversationId);

      writeMarker({
        conversationId,
        sessionId: conversationId,
        adapter,
        thread: r.thread?.thread ?? null,
        workspace,
        active: true,
        updatedAt: Date.now(),
      });
      await daemonRequest("POST", "/send", {
        sessionId: conversationId,
        text: `🟢 *remote chat mode on* for \`${title}\`. I'll post summaries here; reply to steer me. Say \`stop\` to end.`,
      }).catch(() => {});

      const update = await updatePromise;
      const legacyNote = legacy
        ? "\n\n(note: bound via a legacy handshake — your chat-bridge hooks are out of date. Run `npx " +
          packageName() +
          "@latest install`, then fully quit and reopen Cursor.)"
        : "";
      return text(startReply(adapter, r.thread?.thread, conversationId, updateNote(update)) + legacyNote);
    }

    // --- Non-start tools: session is REQUIRED (no recency/cache fallback) --------------------
    const conversationId = resolveActiveConversation(args.session);
    if (!conversationId) {
      return text(
        args.session
          ? `remote chat mode: unknown session "${String(args.session)}" — no active session for that handle. ` +
              `Call bridge_start for this conversation first.`
          : `remote chat mode: missing required 'session'. Pass session=<the handle returned by bridge_start> to ` +
              `${name}. If you haven't started yet, call bridge_start first.`
      );
    }

    if (name === "bridge_send") {
      await daemonRequest("POST", "/send", { sessionId: conversationId, text: String(args.text ?? args.message ?? "") });
      return text("sent");
    }

    if (name === "bridge_await" || name === "bridge_send_and_await") {
      if (name === "bridge_send_and_await") {
        await daemonRequest("POST", "/send", { sessionId: conversationId, text: String(args.text ?? args.message ?? "") });
      }
      const maxBlockMs = Math.min(Number(args.maxBlockMs ?? 50000), 55000);
      const r = await daemonRequest(
        "GET",
        `/poll?sessionId=${encodeURIComponent(conversationId)}&waitMs=${maxBlockMs}`,
        undefined,
        maxBlockMs + 10000
      );
      if (r.stopped) {
        clearMarker(conversationId);
        return text(JSON.stringify({ status: "stopped", messages: r.messages ?? [] }));
      }
      if (r.messages?.length) {
        const reply = r.messages.map((m: any) => m.text).join("\n");
        return text(JSON.stringify({ status: "message", reply, messages: r.messages }));
      }
      return text(JSON.stringify({ status: "timeout" }));
    }

    if (name === "bridge_stop") {
      await daemonRequest("POST", "/stop", { sessionId: conversationId }).catch(() => {});
      clearMarker(conversationId);
      return text("remote chat mode OFF for this conversation.");
    }

    if (name === "bridge_status") {
      const s = await daemonRequest("GET", `/status?sessionId=${encodeURIComponent(conversationId)}`);
      return text(JSON.stringify(s, null, 2));
    }

    return text(`unknown tool ${name}`);
  } catch (e: any) {
    return text(`error: ${e?.message ?? e}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
