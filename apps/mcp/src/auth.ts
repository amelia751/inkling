// todo17 D12: the remote server is an OAuth 2.1 resource server (MCP authorization spec). It
// publishes protected-resource metadata (RFC 9728) naming WorkOS AuthKit as the authorization
// server, answers 401 with `WWW-Authenticate: Bearer resource_metadata=…, scope=…` without a
// usable token and 403 `insufficient_scope` for step-up. It never trusts a token on its own:
// the bearer is forwarded to the API, which verifies it (signature, audience, revocation). The
// checks here only answer early: an expired JWT, one bound to another audience, a missing scope.
import type { IncomingMessage } from "node:http";
import { createHash } from "node:crypto";
import type { McpConfig } from "./config.js";
import { NAMING } from "./config.js";
import { SCOPES } from "./operations.js";

export const METADATA_PATH = "/.well-known/oauth-protected-resource";

export function bearer(req: Pick<IncomingMessage, "headers">): string | undefined {
  const h = req.headers.authorization;
  if (typeof h !== "string") return undefined;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  return m?.[1];
}

/** Stable, non-reversible id for a token (rate-limit keys, logs). */
export const tokenId = (token: string) => createHash("sha256").update(token).digest("hex").slice(0, 32);

/** The resource metadata URL for this server's public URL: `<origin>/.well-known/oauth-protected-resource<path>`. */
export function metadataUrl(config: Pick<McpConfig, "publicUrl">): string {
  const u = new URL(config.publicUrl);
  const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
  return `${u.origin}${METADATA_PATH}${path}`;
}

export function protectedResourceMetadata(config: Pick<McpConfig, "publicUrl" | "authServer">) {
  return {
    resource: config.publicUrl,
    authorization_servers: config.authServer ? [config.authServer] : [],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: `${NAMING.displayName} MCP`,
  };
}

const q = (s: string) => `"${s.replace(/["\\]/g, "")}"`;

/** The `WWW-Authenticate` value for a 401 or 403 (RFC 6750 §3, RFC 9728 §5.1). */
export function wwwAuthenticate(config: Pick<McpConfig, "publicUrl">, opts: { error?: "invalid_token" | "insufficient_scope"; scope?: string; description?: string } = {}): string {
  const parts = [`resource_metadata=${q(metadataUrl(config))}`];
  if (opts.error) parts.push(`error=${q(opts.error)}`);
  if (opts.description) parts.push(`error_description=${q(opts.description)}`);
  parts.push(`scope=${q(opts.scope ?? "project:read")}`);
  return `Bearer ${parts.join(", ")}`;
}

/** The claims of a JWT, unverified (the API verifies). Undefined for opaque tokens (API keys, session tokens). */
export function jwtClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const c = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    return c && typeof c === "object" && !Array.isArray(c) ? c : undefined;
  } catch {
    return undefined;
  }
}

/** Scopes a JWT carries (`scope` string or `scopes`/`scp` array), or undefined when unknown. */
export function tokenScopes(claims: Record<string, unknown> | undefined): string[] | undefined {
  if (!claims) return undefined;
  if (typeof claims.scope === "string") return claims.scope.split(/\s+/).filter(Boolean);
  for (const k of ["scopes", "scp"]) if (Array.isArray(claims[k])) return (claims[k] as unknown[]).map(String);
  return undefined;
}

/** Scope implication: a higher tier includes the lower ones. */
const IMPLIES: Record<string, string[]> = {
  "project:read": ["project:write", "project:trash", "project:destroy"],
  "project:write": ["project:trash", "project:destroy"],
  "project:trash": ["project:destroy"],
};

export const hasScope = (scopes: string[], needed: string) => scopes.includes(needed) || (IMPLIES[needed] ?? []).some((s) => scopes.includes(s));

/** Early answer for a JWT: expired, or bound to another audience. Undefined when fine or opaque. */
export function precheck(token: string, config: Pick<McpConfig, "publicUrl">, nowS = Date.now() / 1000): string | undefined {
  const c = jwtClaims(token);
  if (!c) return undefined;
  if (typeof c.exp === "number" && c.exp < nowS) return "token expired";
  if (c.aud !== undefined) {
    const aud = Array.isArray(c.aud) ? c.aud.map(String) : [String(c.aud)];
    const want = config.publicUrl.replace(/\/$/, "");
    const origin = new URL(want).origin;
    if (!aud.some((a) => a.replace(/\/$/, "") === want || a.replace(/\/$/, "") === origin)) return "token audience is not this server";
  }
  return undefined;
}
