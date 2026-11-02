// todo17 D12: `studio-mcp`, the remote MCP server. Streamable HTTP in stateless mode (a fresh
// server and transport per request, nothing kept between requests), so any replica answers any
// call. Every /mcp request needs a bearer token: missing or rejected → 401 with the resource
// metadata; a JWT without the tool's scope → 403 insufficient_scope (step-up). The token is then
// checked by the API itself on every call it forwards, with the caller's identity and scopes.
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { bearer, hasScope, jwtClaims, METADATA_PATH, precheck, protectedResourceMetadata, tokenId, tokenScopes, wwwAuthenticate } from "./auth.js";
import type { McpConfig } from "./config.js";
import { type CounterStore, Limiter, MemoryStore, RedisStore } from "./limits.js";
import { apiCall, isWriteCall, requiredScope, SCOPE_BY_TIER } from "./operations.js";
import { createServer, ENV_WRITES } from "./server.js";

const MAX_BODY = 4 * 1024 * 1024;
const VERSION = "0.1.0";

/** Token check against the API (it verifies signature, audience, revocation): any 401 there is ours. */
export type TokenVerifier = (token: string) => Promise<boolean>;

export const apiVerifier =
  (config: Pick<McpConfig, "apiUrl">): TokenVerifier =>
  async (token) => {
    // Any authenticated read works; the project list is the cheapest every principal may call.
    const r = await apiCall({ apiUrl: config.apiUrl, token, retries: 1 }, "GET", "/api/v1/projects");
    return r.status !== 401;
  };

export interface HttpDeps {
  config: McpConfig;
  store?: CounterStore;
  verify?: TokenVerifier;
  now?: () => number;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json", "Cache-Control": "no-store", ...headers });
  res.end(text);
}

const rpcError = (code: number, message: string, data?: unknown) => ({ jsonrpc: "2.0", id: null, error: { code, message, ...(data ? { data } : {}) } });

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("invalid JSON"), { status: 400 });
  }
}

type Call = { name: string; args: Record<string, unknown> | undefined };
const toolCalls = (body: unknown): Call[] =>
  (Array.isArray(body) ? body : [body])
    .filter((m: any) => m && m.method === "tools/call" && m.params && typeof m.params.name === "string")
    .map((m: any) => ({ name: m.params.name, args: m.params.arguments }));

/** Scope a tool needs: catalogue tiers, environment writes are writes, everything else is a read. */
const scopeFor = (name: string) => requiredScope(name) ?? (ENV_WRITES.has(name) ? SCOPE_BY_TIER.write : SCOPE_BY_TIER.read);

export function createHandler(deps: HttpDeps) {
  const { config } = deps;
  const store = deps.store ?? (config.redisUrl ? new RedisStore(config.redisUrl, config.redisCaFile) : new MemoryStore(deps.now));
  const limiter = new Limiter(store, config.rateLimitPerMin, config.writeQuotaPerDay, deps.now);
  const verify = deps.verify ?? apiVerifier(config);
  const mcpPath = new URL(config.publicUrl).pathname.replace(/\/$/, "") || "/mcp";
  const unauthorized = (res: ServerResponse, description?: string) =>
    send(res, 401, { error: "invalid_token", error_description: description ?? "Bearer token required" }, { "WWW-Authenticate": wwwAuthenticate(config, { ...(description ? { error: "invalid_token", description } : {}) }) });

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://local");
    const path = url.pathname.replace(/\/$/, "") || "/";
    try {
      if (req.method === "GET" && path === "/healthz") return send(res, 200, { ok: true });
      if (req.method === "GET" && path === "/readyz") {
        const ok = await store.ready();
        return send(res, ok ? 200 : 503, { ok, store: config.redisUrl ? "redis" : "memory" });
      }
      if (req.method === "GET" && path === "/version") return send(res, 200, { service: "mcp", version: VERSION, gitSha: config.gitSha ?? null });
      if (req.method === "GET" && (path === METADATA_PATH || path.startsWith(`${METADATA_PATH}/`))) return send(res, 200, protectedResourceMetadata(config), { "Access-Control-Allow-Origin": "*" });
      if (path !== mcpPath && path !== "/mcp") return send(res, 404, { error: "not found" });
      if (req.method !== "POST") return send(res, 405, rpcError(-32000, "Method not allowed: this server is stateless (POST only)"), { Allow: "POST" });

      const token = bearer(req);
      if (!token) return unauthorized(res);
      const early = precheck(token, config, (deps.now?.() ?? Date.now()) / 1000);
      if (early) return unauthorized(res, early);
      if (!(await verify(token))) return unauthorized(res, "token rejected or revoked");

      const body = await readJson(req);
      const calls = toolCalls(body);
      // Step-up: a JWT says which scopes it has; refuse early with the one it lacks.
      const scopes = tokenScopes(jwtClaims(token));
      if (scopes) {
        const missing = calls.map((c) => scopeFor(c.name)).find((s) => !hasScope(scopes, s));
        if (missing) {
          return send(res, 403, { error: "insufficient_scope", error_description: `This tool needs the ${missing} scope`, scope: missing }, { "WWW-Authenticate": wwwAuthenticate(config, { error: "insufficient_scope", scope: missing, description: `needs ${missing}` }) });
        }
      }
      const id = tokenId(token);
      const write = calls.some((c) => isWriteCall(c.name, c.args, ENV_WRITES));
      // Counters down (Redis unreachable): serve rather than fail every call; /readyz reports it.
      const limit = await limiter.hit(id, write).catch((e) => {
        process.stderr.write(`mcp: rate-limit store unavailable: ${e instanceof Error ? e.message : e}\n`);
        return { ok: true } as const;
      });
      if (!limit.ok) {
        const msg = limit.kind === "rate" ? `Rate limit: ${limit.limit} calls per minute per token. Retry after ${limit.retryAfterS} s.` : `Daily write quota: ${limit.limit} writes per day per token. Retry after ${limit.retryAfterS} s, or ask a person to raise it.`;
        return send(res, 429, rpcError(-32029, msg, { kind: limit.kind, limit: limit.limit, retryAfterS: limit.retryAfterS }), { "Retry-After": String(limit.retryAfterS) });
      }

      const server = createServer(config, token, { remote: true });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      const status = (e as { status?: number }).status ?? 500;
      if (!res.headersSent) send(res, status, rpcError(status === 500 ? -32603 : -32700, e instanceof Error ? e.message : String(e)));
    }
  };
}

export function startHttp(config: McpConfig): HttpServer {
  const server = createHttpServer(createHandler({ config }));
  server.listen(config.port, config.host, () => {
    process.stderr.write(`mcp: streamable HTTP on http://${config.host}:${config.port}${new URL(config.publicUrl).pathname} (resource ${config.publicUrl})\n`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  return server;
}
