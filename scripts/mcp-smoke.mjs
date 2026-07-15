#!/usr/bin/env node
// Smoke test: drive the MCP server over stdio like Cursor would.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "dist", "mcp.js")],
  cwd: root,
  env: { ...process.env, NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS || "" },
});

const client = new Client({ name: "smoke", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

const start = await client.callTool({ name: "bridge_start", arguments: { title: "MCP smoke", adapter: "github" } });
console.log("START:", start.content?.[0]?.text);

const status = await client.callTool({ name: "bridge_status", arguments: {} });
console.log("STATUS:", status.content?.[0]?.text);

await client.close();
process.exit(0);
