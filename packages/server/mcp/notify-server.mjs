// Demo MCP notification server (stdio). Ships with the server package so its
// imports resolve in both local dev and the docker image; referenced by the
// seeded notify@1 skill. Logs deliveries to stderr and echoes a receipt.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "makerchecker-notify", version: "0.0.0" });

server.registerTool(
  "notify",
  {
    description: "Deliver a notification message to a channel.",
    inputSchema: { channel: z.string(), message: z.string() },
  },
  async ({ channel, message }) => {
    console.error(`[notify] ${channel}: ${message}`);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            delivered: true,
            channel,
            message,
            deliveredAt: new Date().toISOString(),
          }),
        },
      ],
    };
  },
);

await server.connect(new StdioServerTransport());
