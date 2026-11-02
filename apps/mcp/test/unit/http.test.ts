import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig, NAMING } from "../../src/config.ts";
import { createHandler } from "../../src/http.ts";
import { MemoryStore } from "../../src/limits.ts";

const k = (key: string) => `${NAMING.envPrefix}${key}`;
let api: Server;
let mcp: Server;
let base = "";
const apiCalls: { method: string; url: string; auth?: string; idem?: string }[] = [];

const jwt = (claims: Record<string, unknown>) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

before(async () => {
  api = createServer((req, res) => {
    apiCalls.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, idem: req.headers["idempotency-key"] as string | undefined });
    if (req.headers.authorization === "Bearer revoked") return void res.writeHead(401).end("{}");
    if (req.url?.endsWith("/context")) return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ project: { id: "p1" }, rules: {} }));
    if (req.url?.includes("/datasets") && req.method === "POST")
      return void res.writeHead(422, { "Content-Type": "application/problem+json" }).end(JSON.stringify({ title: "Rejected", code: "write_rejected", violations: [{ rule: "datasets.metadata", severity: "error", path: "/license", message: "license is required", fix: "Add a license" }] }));
    res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
  });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
  const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  mcp = createServer();
  await new Promise<void>((r) => mcp.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(mcp.address() as AddressInfo).port}`;
  const config = loadConfig({ [k("API_URL")]: apiUrl, [k("MCP_PUBLIC_URL")]: `${base}/mcp`, [k("MCP_AUTH_SERVER")]: "https://auth.example.authkit.app", [k("MCP_RATE_LIMIT_PER_MIN")]: "20" }, []);
  mcp.on("request", createHandler({ config, store: new MemoryStore() }));
});
after(() => {
  mcp.close();
  api.close();
});

test("health, version and protected resource metadata", async () => {
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/readyz`)).status, 200);
  assert.equal(((await (await fetch(`${base}/version`)).json()) as any).service, "mcp");
  const m = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as any;
  assert.equal(m.resource, `${base}/mcp`);
  assert.deepEqual(m.authorization_servers, ["https://auth.example.authkit.app"]);
  assert.ok(m.scopes_supported.includes("project:write"));
});

const rpc = (headers: Record<string, string>, body: unknown) =>
  fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });

test("401 with resource metadata without a token, or with a rejected one", async () => {
  const r = await rpc({}, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(r.status, 401);
  const h = r.headers.get("www-authenticate")!;
  assert.match(h, /^Bearer resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);
  assert.match(h, /scope="project:read"/);
  const revoked = await rpc({ Authorization: "Bearer revoked" }, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(revoked.status, 401);
  assert.match(revoked.headers.get("www-authenticate")!, /error="invalid_token"/);
  const expired = await rpc({ Authorization: `Bearer ${jwt({ exp: 1 })}` }, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(expired.status, 401);
  const otherAud = await rpc({ Authorization: `Bearer ${jwt({ aud: "https://elsewhere" })}` }, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(otherAud.status, 401);
});

test("403 insufficient_scope for a write with a read-only token", async () => {
  const token = jwt({ aud: `${base}/mcp`, scope: "project:read" });
  const r = await rpc({ Authorization: `Bearer ${token}` }, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "dataset_create", arguments: { projectId: "p1", name: "x" } } });
  assert.equal(r.status, 403);
  assert.match(r.headers.get("www-authenticate")!, /error="insufficient_scope".*scope="project:write"/);
});

test("an MCP client over HTTP: tools, context, a rejection with its fix", async () => {
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: "Bearer good" } } }));
  const { tools } = await client.listTools();
  assert.equal(tools[0]!.name, "project_context");
  assert.equal(tools.find((t) => t.name === "dataset_delete")!.annotations!.destructiveHint, true);
  const ctx = await client.callTool({ name: "project_context", arguments: { projectId: "p1" } });
  assert.match((ctx.content as any)[0].text, /"id": "p1"/);
  const res = await client.readResource({ uri: "studio://projects/p1/context" });
  assert.match((res.contents[0] as any).text, /p1/);
  const bad = await client.callTool({ name: "dataset_create", arguments: { projectId: "p1", name: "x" } });
  assert.equal(bad.isError, true);
  assert.match((bad.content as any)[0].text, /datasets\.metadata at \/license: license is required Fix: Add a license/);
  const post = apiCalls.find((c) => c.method === "POST" && c.url.includes("/datasets"))!;
  assert.equal(post.auth, "Bearer good", "the caller's token is forwarded");
  assert.match(post.idem!, /^[0-9a-f-]{36}$/);
  await client.close();
});

test("rate limit: 429 with Retry-After past the per-minute limit", async () => {
  let last: Response | undefined;
  for (let i = 0; i < 25; i++) {
    last = await rpc({ Authorization: "Bearer busy" }, { jsonrpc: "2.0", id: i, method: "ping" });
    if (last.status === 429) break;
  }
  assert.equal(last!.status, 429);
  assert.ok(Number(last!.headers.get("retry-after")) >= 1);
});
