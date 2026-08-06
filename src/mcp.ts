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
    "Session handle returned by bridge_start for THIS conversation. Routes the call to the right chat thread and " +
    "keeps concurrent conversations — even two in the same workspace — from crossing over.",
};

const TEXT_ARG = {
  type: "string",
  description:
    "Message body to post, as plain text — typically the end-of-turn summary plus the question you need answered. " +
    "Keep credentials and secrets out of it: whoever can read the chat thread can read this.",
};

const MAX_BLOCK_MS_ARG = {
  type: "number",
  description:
    "How long to wait for a reply before giving up and returning status 'timeout', in milliseconds. Defaults to " +
    "50000 and is capped at 55000 to stay inside the MCP call timeout — wait longer by calling again, not by raising this.",
};

const TOOLS = [
  {
    name: "bridge_start",
    title: "Start remote chat mode",
    description:
      "Opens a dedicated thread for THIS conversation in the configured chat channel (GitHub issue, Telegram topic, " +
      "or Discord channel) and returns the session handle that every other bridge_* tool requires. Call it when the " +
      "user asks — in any language — to start remote chat, bridge, or Telegram mode. " +
      "Call it once per conversation: every call without `session` opens a NEW thread, so re-arm an existing session " +
      "by passing its handle back instead of starting again. " +
      "When no channel is configured it returns onboarding instructions rather than failing, so follow them and call " +
      "again. It identifies the conversation from Cursor's pending handshake and fails closed with guidance when that " +
      "is ambiguous — it will not guess which conversation it belongs to.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description:
            "Names the thread — a concise (≤6-word) summary of THIS conversation's topic, mirroring how it reads in " +
            'Cursor\'s chat list (e.g. "GitHub Actions autopublish"). Falls back to the folder name, which is a poor ' +
            "label when several conversations share a workspace.",
        },
        adapter: {
          type: "string",
          enum: ["github", "telegram", "discord"],
          description: "Chat channel to use for this session, overriding the configured default.",
        },
        session: {
          type: "string",
          description:
            "Handle from a previous bridge_start, to re-arm that existing session instead of opening a second thread. " +
            "Omit for a brand-new start.",
        },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "bridge_send",
    title: "Post a message to the chat thread",
    description:
      "Posts one message to this conversation's chat thread and returns immediately without waiting for a reply. " +
      "Use it for a progress note or a closing remark that needs no answer; when you need the user to respond, use " +
      "bridge_send_and_await instead so the post and the wait are one call. " +
      "Each call appends a new message and never edits or replaces an earlier one, so a retry after a failure leaves " +
      "a duplicate in the thread.",
    inputSchema: {
      type: "object",
      properties: {
        text: TEXT_ARG,
        message: { ...TEXT_ARG, description: `Alias for \`text\`; ignored when \`text\` is present. ${TEXT_ARG.description}` },
        session: SESSION_ARG,
      },
      required: ["session"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "bridge_await",
    title: "Wait for the user's reply",
    description:
      "Blocks on this conversation's chat thread for a single long-poll window and returns JSON with status " +
      "'message' plus the reply text, 'timeout', or 'stopped'. Use it when you already posted with bridge_send and " +
      "only need the answer; to post and wait together, prefer bridge_send_and_await. " +
      "Replies are consumed as they are delivered, so each message comes back exactly once and a later call will not " +
      "see it again. A 'timeout' is normal rather than an error — the window elapsed with no reply, and you keep " +
      "waiting by calling again. 'stopped' means the user ended remote chat mode, so stop calling bridge_* tools " +
      "until a new bridge_start.",
    inputSchema: {
      type: "object",
      properties: { maxBlockMs: MAX_BLOCK_MS_ARG, session: SESSION_ARG },
      required: ["session"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "bridge_send_and_await",
    title: "Post a message and wait for the reply",
    description:
      "Posts a message to this conversation's chat thread and then blocks for the reply in one round trip — the " +
      "end-of-turn summary-plus-question pattern, and the tool to reach for by default. Equivalent to bridge_send " +
      "followed by bridge_await; use those separately only when you need to post and wait at different moments. " +
      "Returns the same envelope as bridge_await: 'message' with the reply, 'timeout', or 'stopped'. The message is " +
      "posted before the wait begins, so after a 'timeout' the user has already seen it — send only what is new " +
      "rather than repeating the summary, which would post it twice.",
    inputSchema: {
      type: "object",
      properties: {
        text: TEXT_ARG,
        message: { ...TEXT_ARG, description: `Alias for \`text\`; ignored when \`text\` is present. ${TEXT_ARG.description}` },
        maxBlockMs: MAX_BLOCK_MS_ARG,
        session: SESSION_ARG,
      },
      required: ["session"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "bridge_stop",
    title: "End remote chat mode",
    description:
      "Ends remote chat mode for THIS conversation: the daemon stops polling the thread, any in-flight wait returns " +
      "'stopped', and the session handle stops working — resuming later needs a fresh bridge_start. " +
      "The conversation history is left intact; the thread is not deleted and a GitHub issue is not closed, so the " +
      "record stays readable afterwards. Calling it twice, or on a session that already ended, is harmless. " +
      "Use it when the user says they are done — not in response to a 'timeout' from bridge_await, which only means " +
      "no reply has arrived yet.",
    inputSchema: { type: "object", properties: { session: SESSION_ARG }, required: ["session"] },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "bridge_status",
    title: "Show remote chat mode status",
    description:
      "Reports the bridge's record for THIS conversation as JSON — which adapter is in use, the thread it is bound " +
      "to, and whether the session is still active — or a null session once it has ended. " +
      "Diagnostics only: it posts nothing to the thread and does not consume a pending reply, so unlike bridge_await " +
      "it is safe to call at any point, including while deciding whether a bridge_start is still needed. " +
      "It answers from local daemon state without contacting the chat provider, so it confirms what the bridge " +
      "believes rather than that the provider is reachable.",
    inputSchema: { type: "object", properties: { session: SESSION_ARG }, required: ["session"] },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
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
