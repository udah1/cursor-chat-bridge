#!/usr/bin/env node
import crypto from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { daemonRequest } from "./daemonClient.js";
import { loadConfig } from "./config.js";
import { readMarker, writeMarker, clearMarker } from "./markers.js";

const CWD = process.cwd();

function currentSessionId(): string | null {
  return readMarker(CWD)?.sessionId ?? null;
}

function text(s: string) {
  return { content: [{ type: "text", text: s }] };
}

const TOOLS = [
  {
    name: "bridge_start",
    description:
      "Start chat-bridge mode for this session: opens a per-session thread in the configured chat channel " +
      "(GitHub issue / Telegram topic / Teams chat) and routes end-of-turn summaries there. Call this when the " +
      "user says 'start telegram mode' / 'start bridge mode' (in any language).",
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
    description: "Post a message (e.g. a turn summary or a question) to this session's chat thread.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "bridge_await",
    description:
      "Block waiting for the user's reply in the chat thread (single long-poll window). Returns the reply text, " +
      "or status 'timeout' (call again to keep waiting) or 'stopped' (mode ended).",
    inputSchema: { type: "object", properties: { maxBlockMs: { type: "number" } } },
  },
  {
    name: "bridge_send_and_await",
    description: "Post a message then block for the user's reply. Convenience for end-of-turn summary + question.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" }, maxBlockMs: { type: "number" } },
      required: ["text"],
    },
  },
  { name: "bridge_stop", description: "Stop chat-bridge mode for this session.", inputSchema: { type: "object", properties: {} } },
  { name: "bridge_status", description: "Show chat-bridge status for this session.", inputSchema: { type: "object", properties: {} } },
];

const server = new Server({ name: "cursor-chat-bridge", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, any>;
  const cfg = loadConfig();

  try {
    if (name === "bridge_start") {
      const sessionId = currentSessionId() ?? crypto.randomUUID();
      const title = args.title || CWD.split("/").pop() || "cursor-session";
      const adapter = args.adapter || cfg.activeAdapter;
      const r = await daemonRequest("POST", "/register", { sessionId, title, cwd: CWD, adapter });
      writeMarker({ sessionId, adapter, thread: r.thread?.thread ?? null, cwd: CWD, active: true, updatedAt: Date.now() });
      await daemonRequest("POST", "/send", {
        sessionId,
        text: `🟢 *chat-bridge mode on* for \`${title}\`. I'll post summaries here; reply to steer me. Say \`stop\` to end.`,
      }).catch(() => {});
      return text(
        `chat-bridge mode ON via "${adapter}". Session ${sessionId}, thread ${r.thread?.thread}. ` +
          `From now on, at the end of each turn send a summary + question with bridge_send_and_await, and act on the reply. Do not use the Options/Questions UI.`
      );
    }

    const sessionId = currentSessionId();
    if (!sessionId) return text("chat-bridge is not active for this session. Call bridge_start first.");

    if (name === "bridge_send") {
      await daemonRequest("POST", "/send", { sessionId, text: String(args.text ?? "") });
      return text("sent");
    }

    if (name === "bridge_await" || name === "bridge_send_and_await") {
      if (name === "bridge_send_and_await") {
        await daemonRequest("POST", "/send", { sessionId, text: String(args.text ?? "") });
      }
      const maxBlockMs = Math.min(Number(args.maxBlockMs ?? 50000), 55000);
      const r = await daemonRequest(
        "GET",
        `/poll?sessionId=${encodeURIComponent(sessionId)}&waitMs=${maxBlockMs}`,
        undefined,
        maxBlockMs + 10000
      );
      if (r.stopped) {
        clearMarker(CWD);
        return text(JSON.stringify({ status: "stopped", messages: r.messages ?? [] }));
      }
      if (r.messages?.length) {
        const reply = r.messages.map((m: any) => m.text).join("\n");
        return text(JSON.stringify({ status: "message", reply, messages: r.messages }));
      }
      return text(JSON.stringify({ status: "timeout" }));
    }

    if (name === "bridge_stop") {
      await daemonRequest("POST", "/stop", { sessionId }).catch(() => {});
      clearMarker(CWD);
      return text("chat-bridge mode OFF for this session.");
    }

    if (name === "bridge_status") {
      const s = await daemonRequest("GET", `/status?sessionId=${encodeURIComponent(sessionId)}`);
      return text(JSON.stringify(s, null, 2));
    }

    return text(`unknown tool ${name}`);
  } catch (e: any) {
    return text(`error: ${e?.message ?? e}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
