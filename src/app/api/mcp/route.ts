import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { isAuthorized } from "@/server/mcp/auth";
import { createMcpServer } from "@/server/mcp/createServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Streamable HTTP endpoint for MCP clients that connect over the network
 * (ChatGPT, Cursor with `url` transport, custom hosts). Stateless — each
 * request spins up its own `McpServer` + transport pair; the heavy shared
 * state (queue, lanes, Chrome sessions) lives on `globalThis` so it's
 * preserved across requests.
 *
 * The Web-standard transport accepts a `Request` and returns a `Response`,
 * which is exactly what Next.js App Router handlers expect — no adapter
 * layer needed.
 */

async function handle(req: Request): Promise<Response> {
  if (!isAuthorized(req.headers.get("authorization"))) {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: "Unauthorized: missing or invalid Bearer token",
        },
        id: null,
      }),
      {
        status: 401,
        headers: {
          "content-type": "application/json",
          "www-authenticate": 'Bearer realm="wsu-mcp"',
        },
      },
    );
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  const server = createMcpServer();
  try {
    await server.connect(transport);
    return await transport.handleRequest(req);
  } catch (err) {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: err instanceof Error ? err.message : String(err),
        },
        id: null,
      }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }
}

export { handle as GET, handle as POST, handle as DELETE };
