#!/usr/bin/env node
/**
 * Stdio MCP entry point. Cursor / Claude Desktop spawn this as a subprocess
 * and talk JSON-RPC over stdin/stdout. No Next.js server required.
 *
 * Usage (in the MCP client's config):
 *   {
 *     "mcpServers": {
 *       "workflow-space-ultra": {
 *         "command": "node",
 *         "args": ["<absolute-path>/bin/wsu-mcp.mjs"],
 *         "cwd": "<absolute-path-to-workflow-space-ultra>"
 *       }
 *     }
 *   }
 *
 * The `cwd` matters — the MCP server uses `process.cwd()` to locate
 * `data_general/`, `Workflows/`, and the Chrome user-data dirs (same
 * contract the Next.js server uses). If you skip it, the server will read
 * from wherever the client happened to launch you.
 */
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const bundled = resolve(__dirname, "..", "dist-mcp", "createServer.mjs");

if (!existsSync(bundled)) {
  process.stderr.write(
    `[wsu-mcp] dist-mcp/createServer.mjs not found.\n` +
      `Run 'npm run mcp:build' from the project root first.\n`,
  );
  process.exit(1);
}

// Windows requires file:// URLs for dynamic import of absolute paths.
const { createMcpServer } = await import(pathToFileURL(bundled).href);
const server = createMcpServer();
const transport = new StdioServerTransport();

// Writes to stdout become JSON-RPC frames for the MCP client. Anything else
// MUST go to stderr or it corrupts the protocol.
const origLog = console.log;
console.log = (...args) => console.error("[wsu-mcp]", ...args);
console.info = (...args) => console.error("[wsu-mcp]", ...args);
console.warn = (...args) => console.error("[wsu-mcp:warn]", ...args);
console.debug = (...args) => console.error("[wsu-mcp:debug]", ...args);

await server.connect(transport);

// Graceful shutdown on SIGINT/SIGTERM keeps Chrome / queue state consistent.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    try {
      await server.close();
    } finally {
      origLog;
      process.exit(0);
    }
  });
}
