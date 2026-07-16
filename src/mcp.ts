#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { daemonRequest } from "./daemonClient.js";
import { loadConfig } from "./config.js";
import { readMarker, writeMarker, clearMarker, readLastSubmit, readWsPointer } from "./markers.js";
import { checkAdapterConfig } from "./onboarding.js";
import { LOG_PATH, ensureRuntimeDir } from "./paths.js";
import { checkForUpdate, currentVersion, packageName } from "./version.js";

// Cursor resolves ${workspaceFolder} per window; falls back to cwd if not provided.
const WORKSPACE = process.env.BRIDGE_WORKSPACE || process.cwd();

// The conversation this MCP process most recently started bridge mode for. Primary key so
// end-of-turn tool calls resolve to the right session even under multi-window concurrency.
let activeConversationId: string | null = null;

function debug(msg: string): void {
  try {
    ensureRuntimeDir();
    fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] [mcp] ${msg}\n`);
  } catch {}
}

/**
 * Resolve the session for non-start tools. Priority:
 *  1. explicit `session` handle the agent carries from bridge_start (disambiguates multiple
 *     conversations in the SAME workspace / shared MCP process — the only fully reliable signal),
 *  2. in-process cache, 3. per-workspace pointer, 4. most recent submit.
 */
function resolveConversationId(explicit?: unknown): string | null {
  if (explicit) return String(explicit);
  if (activeConversationId) return activeConversationId;
  const ws = readWsPointer(WORKSPACE)?.conversationId;
  if (ws && readMarker(ws)?.active) return ws;
  // last-submit is a single global file; only trust it if it was written for OUR workspace,
  // otherwise a different Cursor window's submit could hijack this conversation.
  const ls = readLastSubmit();
  if (ls?.conversationId && ls.workspace === WORKSPACE && readMarker(ls.conversationId)?.active) {
    return ls.conversationId;
  }
  return null;
}

function text(s: string) {
  return { content: [{ type: "text", text: s }] };
}

const SESSION_ARG = {
  type: "string",
  description:
    "The session handle returned by bridge_start for THIS conversation. Always pass it so the right chat thread " +
    "is used (required to keep multiple conversations in the same workspace separate).",
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
      },
    },
  },
  {
    name: "bridge_send",
    description:
      "Post a message (e.g. a turn summary or a question) to this conversation's chat thread. Put the message in " +
      "the `text` argument (alias: `message`). Pass the `session` handle returned by bridge_start.",
    inputSchema: {
      type: "object",
      properties: { text: TEXT_ARG, message: TEXT_ARG, session: SESSION_ARG },
    },
  },
  {
    name: "bridge_await",
    description:
      "Block waiting for the user's reply in the chat thread (single long-poll window). Returns the reply text, " +
      "or status 'timeout' (call again to keep waiting) or 'stopped' (mode ended). Pass the `session` handle from bridge_start.",
    inputSchema: { type: "object", properties: { maxBlockMs: { type: "number" }, session: SESSION_ARG } },
  },
  {
    name: "bridge_send_and_await",
    description:
      "Post a message then block for the user's reply. Convenience for end-of-turn summary + question. Put the " +
      "message in the `text` argument (alias: `message`). Pass the `session` handle returned by bridge_start.",
    inputSchema: {
      type: "object",
      properties: { text: TEXT_ARG, message: TEXT_ARG, maxBlockMs: { type: "number" }, session: SESSION_ARG },
    },
  },
  {
    name: "bridge_stop",
    description: "Stop remote chat mode for this conversation. Pass the `session` handle from bridge_start.",
    inputSchema: { type: "object", properties: { session: SESSION_ARG } },
  },
  {
    name: "bridge_status",
    description: "Show remote chat mode status for this conversation. Pass the `session` handle from bridge_start.",
    inputSchema: { type: "object", properties: { session: SESSION_ARG } },
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

      // Onboard the user if the chosen channel isn't fully configured.
      const check = checkAdapterConfig(adapter, cfg);
      if (!check.ok) return text(check.guidance ?? `Adapter "${adapter}" is not configured.`);

      // Best-effort "is there a newer release?" check, run in parallel with registration so it
      // doesn't add latency. Surfaced in the response for the agent to raise with the user.
      const updatePromise = checkForUpdate().catch(
        () => ({ current: currentVersion(), latest: undefined, updateAvailable: false })
      );

      // Learn this conversation's id from the beforeSubmit handshake (written moments ago).
      // Priority matters under concurrent windows:
      //   1. explicit `session` the agent supplied (fully reliable),
      //   2. the PER-WORKSPACE pointer — each window's hook writes ws/<hash(workspace)>.json, so
      //      this is race-free across windows (unlike last-submit.json which is a single global
      //      file every window overwrites),
      //   3. last-submit ONLY if its workspace matches ours (so a different window's submit can't
      //      hijack our id),
      //   4. a fresh random id as a last resort.
      const ls = readLastSubmit();
      const wsPtr = readWsPointer(WORKSPACE)?.conversationId;
      const lsMatchesWs = ls && ls.workspace && ls.workspace === WORKSPACE ? ls.conversationId : null;
      const conversationId =
        (args.session ? String(args.session) : null) ?? wsPtr ?? lsMatchesWs ?? crypto.randomUUID();
      const workspace = WORKSPACE || ls?.workspace || "";
      const title = args.title || workspace.split("/").pop() || "cursor-session";
      debug(`bridge_start workspace=${workspace} conversationId=${conversationId} adapter=${adapter}`);

      const r = await daemonRequest("POST", "/register", { sessionId: conversationId, title, cwd: workspace, adapter });
      activeConversationId = conversationId;
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
      const updateNote = update.updateAvailable
        ? `\n\n⬆️ UPDATE AVAILABLE: ${update.current} → ${update.latest}. Before continuing, tell the user and ask ` +
          `(via the normal Cursor question UI — the remote loop hasn't started) whether to update now with ` +
          `\`npx ${packageName()}@latest install\` (then reload Cursor). If they decline, continue normally.`
        : "";

      return text(
        `remote chat mode ON via "${adapter}". Thread ${r.thread?.thread}. ` +
          `Your session handle is "${conversationId}". IMPORTANT: pass session="${conversationId}" to every ` +
          `subsequent bridge_* call so this conversation stays on its own thread. At the end of each turn send a ` +
          `summary + question with bridge_send_and_await (put the message in the "text" argument), act on the reply, ` +
          `and do not use the Options/Questions UI.` +
          updateNote
      );
    }

    const conversationId = resolveConversationId(args.session);
    if (!conversationId) return text("remote chat mode is not active for this conversation. Call bridge_start first.");

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
        if (activeConversationId === conversationId) activeConversationId = null;
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
      if (activeConversationId === conversationId) activeConversationId = null;
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
