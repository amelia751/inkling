// Minimal MCP Apps host harness (todo10 Phase 5 exit: "the same viewer renders in an MCP Apps
// host outside Inkling"). Spawns apps/mcp over stdio with the official MCP client, serves a host
// page that uses the official ext-apps AppBridge (host.ts, bundled with esbuild) on one port and
// the reference sandbox proxy on another, and prints `READY <url>` for a browser to open.
//
//   node test/apps-host/run.mjs --web http://127.0.0.1:8242 --api http://127.0.0.1:8241 \
//     --workspace ply-demo --host-port 8243 --sandbox-port 8244
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { build } from "esbuild";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const mcpDir = path.resolve(here, "../..");
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const NAMING = JSON.parse(readFileSync(path.resolve(mcpDir, "../../schemas/naming.json"), "utf8"));
const hostPort = +arg("host-port", "8243"), sandboxPort = +arg("sandbox-port", "8244");
const sandboxUrl = `http://127.0.0.1:${sandboxPort}/sandbox.html`;

const client = new Client({ name: "mcp-apps-harness", version: "1.0.0" }, { capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } } });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve(mcpDir, "node_modules/tsx/dist/cli.mjs"), path.resolve(mcpDir, "src/main.ts")],
  cwd: mcpDir,
  env: { ...process.env, [`${NAMING.envPrefix}WEB_URL`]: arg("web"), [`${NAMING.envPrefix}API_URL`]: arg("api"), [`${NAMING.envPrefix}MCP_WORKSPACE`]: arg("workspace") },
  stderr: "inherit",
}));

const bundle = await build({ entryPoints: [path.join(here, "host.ts")], bundle: true, format: "esm", write: false, platform: "browser", target: "es2022", define: { SANDBOX_URL: JSON.stringify(sandboxUrl) }, logLevel: "error" });
const hostJs = bundle.outputFiles[0].text;
const hostHtml = `<!doctype html><html><head><meta charset="utf-8"><title>MCP Apps harness host</title></head><body><h1>MCP Apps harness host</h1><p>tool: <code id="tool"></code></p><div id="frame"></div><ol id="log"></ol><script type="module" src="/host.js"></script></body></html>`;

const body = (req) => new Promise((ok) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => ok(s ? JSON.parse(s) : {})); });
const json = (res, v) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end(hostHtml); }
    if (url.pathname === "/host.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(hostJs); }
    if (url.pathname === "/api/tools") return json(res, (await client.listTools()).tools);
    if (url.pathname === "/api/resource") return json(res, await client.readResource({ uri: url.searchParams.get("uri") }));
    if (url.pathname === "/api/call") { const b = await body(req); return json(res, await client.callTool({ name: b.name, arguments: b.arguments ?? {} })); }
    res.writeHead(404).end();
  } catch (e) { res.writeHead(500, { "content-type": "text/plain" }).end(String(e)); }
}).listen(hostPort, "127.0.0.1");

const sandboxHtml = readFileSync(path.join(here, "sandbox.html"));
http.createServer((req, res) => {
  // The reference host sets CSP on the proxy from the resource's declared domains; ours declares none.
  res.writeHead(200, { "content-type": "text/html", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'" });
  res.end(sandboxHtml);
}).listen(sandboxPort, "127.0.0.1");

console.log(`READY http://127.0.0.1:${hostPort}/`);
const stop = async () => { await client.close().catch(() => {}); process.exit(0); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
