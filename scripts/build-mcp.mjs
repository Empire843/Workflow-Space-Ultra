#!/usr/bin/env node
/**
 * Bundle the MCP server factory into a standalone ESM module that
 * `bin/wsu-mcp.mjs` can import directly — no Next.js runtime, no tsc.
 *
 * Why bundle instead of `tsx`?
 *   - Claude Desktop / Cursor spawn the stdio server on every chat session.
 *     Cold-start matters. A pre-built `.mjs` starts ~10x faster than tsx.
 *   - Users without `tsx` installed globally can still run `node bin/...`.
 *
 * Output: `dist-mcp/createServer.mjs` (plus sourcemap). All node_modules are
 * kept external so runtime resolution picks the same versions the Next.js
 * server uses — avoids duplicating playwright / undici into the bundle.
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

await build({
  entryPoints: [resolve(root, "src/server/mcp/createServer.ts")],
  outfile: resolve(root, "dist-mcp/createServer.mjs"),
  platform: "node",
  format: "esm",
  target: "node18",
  bundle: true,
  sourcemap: true,
  packages: "external",
  alias: {
    "@": resolve(root, "src"),
  },
  logLevel: "info",
  banner: {
    // Some node-only deps (playwright bootstrap, etc.) assume CJS-style
    // `__dirname` / `require` exists. We shim both at the top of the ESM
    // bundle so external packages that bundle in CJS still work.
    js:
      "import { createRequire as __wsuCreateRequire } from 'node:module';\n" +
      "import { fileURLToPath as __wsuFileURLToPath } from 'node:url';\n" +
      "import { dirname as __wsuDirname } from 'node:path';\n" +
      "const require = __wsuCreateRequire(import.meta.url);\n" +
      "const __filename = __wsuFileURLToPath(import.meta.url);\n" +
      "const __dirname = __wsuDirname(__filename);",
  },
});
// eslint-disable-next-line no-console
console.log("[mcp] built dist-mcp/createServer.mjs");
