/**
 * @file A minimal stdio MCP server for live tests. Its one tool, `read_token`, returns the
 * `LIVE_MCP_TOKEN` variable it was started with, so a test can tell that a server's `env`
 * reached it however the runtime delivered the config.
 */

import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.id === undefined) return;
  switch (request.method) {
    case "initialize":
      return send({ id: request.id, result: { protocolVersion: request.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "env-mcp", version: "1.0.0" } } });
    case "tools/list":
      return send({ id: request.id, result: { tools: [{ name: "read_token", description: "Returns the server's token.", inputSchema: { type: "object", properties: {} } }] } });
    case "tools/call":
      return send({ id: request.id, result: { content: [{ type: "text", text: process.env.LIVE_MCP_TOKEN ?? "(no token)" }] } });
    default:
      return send({ id: request.id, error: { code: -32601, message: `Unknown method ${request.method}` } });
  }
});
