import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerResources } from "./resources";
import { registerTools } from "./tools";

/**
 * Single source of truth for the MCP server surface. Both transports
 * (`/api/mcp` Streamable HTTP in Next.js AND the stdio shim in
 * `bin/wsu-mcp.mjs`) call this factory so tools + resources stay in lock-step.
 */
export function createMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: "workflow-space-ultra",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
        resources: { listChanged: true },
        logging: {},
      },
      instructions:
        "Workflow Space Ultra exposes VEO 3.1 Ultra + Grok Imagine image/video generation over MCP. " +
        "Image inputs are always URLs (local /api/workflows/... or remote http(s) or data:). " +
        "Generation tools block until the job finishes and return a local file URL you can then " +
        "fetch via the `wsu://workflow/<id>/assets/...` resource URI. " +
        "If auth_status reports a provider as NOT LOGGED IN, call open_login before retrying.",
    },
  );

  registerTools(server);
  registerResources(server);

  return server;
}
