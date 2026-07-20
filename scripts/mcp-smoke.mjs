#!/usr/bin/env node
// Smoke test: drive the MCP server over stdio like Cursor would.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WORKSPACE = "/tmp/ccb-smoke";

// Simulate the beforeSubmit hook: write a fresh pending-start record so bridge_start can CLAIM
// it (it no longer mints a random id — a missing handshake fails closed by design).
const conversationId = `smoke-${Date.now()}`;
const PENDING = path.join(os.homedir(), ".cursor", "chat-bridge", "markers", "pending");
fs.mkdirSync(PENDING, { recursive: true });
fs.writeFileSync(
  path.join(PENDING, `${conversationId}.json`),
  JSON.stringify({ conversationId, workspace: WORKSPACE, at: Date.now() })
);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "dist", "mcp.js")],
  cwd: root,
  env: { ...process.env, BRIDGE_WORKSPACE: WORKSPACE, NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS || "" },
});

const client = new Client({ name: "smoke", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

const start = await client.callTool({ name: "bridge_start", arguments: { title: "MCP smoke", adapter: "github" } });
console.log("START:", start.content?.[0]?.text);

const status = await client.callTool({ name: "bridge_status", arguments: { session: conversationId } });
console.log("STATUS:", status.content?.[0]?.text);

await client.close();
process.exit(0);
