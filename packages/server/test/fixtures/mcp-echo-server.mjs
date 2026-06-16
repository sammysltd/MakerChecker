// Minimal MCP stdio server used by integration tests: one "notify" tool that
// echoes its input back. Proves the MCP-native skill path end to end.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "mc-test-notify", version: "0.0.0" });

server.registerTool(
  "notify",
  {
    description: "Send a notification (test stub: echoes back)",
    inputSchema: { channel: z.string(), message: z.string() },
  },
  async ({ channel, message }) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({ delivered: true, channel, message }),
      },
    ],
  }),
);

await server.connect(new StdioServerTransport());
