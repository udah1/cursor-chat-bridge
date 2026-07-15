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
  const ls = readLastSubmit()?.conversationId;
  if (ls && readMarker(ls)?.active) return ls;
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

const TOOLS = [
  {
    name: "bridge_start",
    description:
      "Start remote chat mode for this conversation: opens a per-conversation thread in the configured chat " +
      "channel (GitHub issue / Telegram topic / Teams chat) and routes end-of-turn summaries there. Call this " +
      "when the user asks to start remote chat / bridge / telegram mode (in any language). If the channel isn't " +
      "configured, this returns setup guidance — follow it to onboard the user, then call bridge_start again.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Human title for the session thread (defaults to the folder name)." },
        adapter: { type: "string", description: "Override the channel adapter (github|telegram|teams)." },
      },
    },
  },
  {
    name: "bridge_send",
    description:
      "Post a message (e.g. a turn summary or a question) to this conversation's chat thread. Pass the `session` " +
      "handle returned by bridge_start.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" }, session: SESSION_ARG },
      required: ["text"],
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
      "Post a message then block for the user's reply. Convenience for end-of-turn summary + question. Pass the " +
      "`session` handle returned by bridge_start.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" }, maxBlockMs: { type: "number" }, session: SESSION_ARG },
      required: ["text"],
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

const server = new Server({ name: "cursor-chat-bridge", version: "0.1.0" }, { capabilities: { tools: {} } });

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

      // Learn this conversation's id from the beforeSubmit handshake (written moments ago).
      const ls = readLastSubmit();
      const conversationId = ls?.conversationId ?? crypto.randomUUID();
      const workspace = process.env.BRIDGE_WORKSPACE || ls?.workspace || WORKSPACE;
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
      return text(
        `remote chat mode ON via "${adapter}". Thread ${r.thread?.thread}. ` +
          `Your session handle is "${conversationId}". IMPORTANT: pass session="${conversationId}" to every ` +
          `subsequent bridge_* call so this conversation stays on its own thread. At the end of each turn send a ` +
          `summary + question with bridge_send_and_await, act on the reply, and do not use the Options/Questions UI.`
      );
    }

    const conversationId = resolveConversationId(args.session);
    if (!conversationId) return text("remote chat mode is not active for this conversation. Call bridge_start first.");

    if (name === "bridge_send") {
      await daemonRequest("POST", "/send", { sessionId: conversationId, text: String(args.text ?? "") });
      return text("sent");
    }

    if (name === "bridge_await" || name === "bridge_send_and_await") {
      if (name === "bridge_send_and_await") {
        await daemonRequest("POST", "/send", { sessionId: conversationId, text: String(args.text ?? "") });
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
