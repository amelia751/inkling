import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { WorkOS } from "@workos-inc/node";
import type { Config } from "../config.ts";
import type { Logger } from "../log.ts";
import { sanitizeError } from "../runtime/events.ts";

/** Header that carries the shared service token on browser-proxied calls in `workos` mode (todo9 Phase 5). */
export const SERVICE_TOKEN_HEADER = "x-agent-service-token";

/**
 * Who a /v1 call acts as. `principal` undefined means the service's single local principal (dev mode),
 * so the session service keeps its own default.
 */
export interface Caller {
  principal: string | undefined;
  orgId: string | undefined;
  via: "service" | "user";
}

export type AppEnv = { Variables: { caller: Caller } };

/** The claims of a WorkOS user access token this service uses (todo9 §2.2). */
export interface AccessClaims {
  sub: string;
  org_id?: string;
  sid?: string;
}

/** Verifies a WorkOS access token: claims, or null when the token is invalid. Throws on transient failures (JWKS unreachable). */
export interface AccessTokenVerifier {
  verify(token: string): Promise<AccessClaims | null>;
}

/**
 * The SDK's `verifyAccessToken` with a client-id-only client (no API key): it checks the signature
 * against `<base>/sso/jwks/<client id>`, expiry, the issuer when configured, and that the token is a
 * user access token (not an agent or widget token).
 */
export function workosVerifier(auth: { clientId: string; issuer: string | undefined; baseUrl: string | undefined }): AccessTokenVerifier {
  const base = auth.baseUrl ? new URL(auth.baseUrl) : undefined;
  const workos = new WorkOS({
    clientId: auth.clientId,
    ...(auth.issuer ? { issuer: auth.issuer } : {}),
    ...(base
      ? { apiHostname: base.hostname, https: base.protocol === "https:", ...(base.port ? { port: Number(base.port) } : {}) }
      : {}),
  });
  return {
    async verify(token) {
      const claims = await workos.userManagement.verifyAccessToken(token);
      return claims ? { sub: claims.sub, org_id: claims.org_id, sid: claims.sid } : null;
    },
  };
}

function matches(value: string | undefined, token: string): boolean {
  if (!value) return false;
  const got = Buffer.from(value.replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

const bearer = (header: string | undefined) => header?.match(/^Bearer\s+(\S+)\s*$/i)?.[1];

/**
 * Authenticates every /v1 call and sets `caller`.
 *
 * - The shared service token is always required, in `X-Agent-Service-Token` or (legacy, dev, and
 *   service-to-service calls) in `Authorization`, so the agent's ingress stays closed to anything but
 *   our proxies.
 * - `dev`: the caller is the local principal.
 * - `workos`: when the token came in `X-Agent-Service-Token`, `Authorization` must carry a valid
 *   WorkOS access token; the caller is `user:<sub>` in `org_id`. A service-only call (token in
 *   `Authorization`, no user) acts as `service` and sees no person's sessions.
 *
 * SSE streams pass through here once, at connect; an open stream outlives the 5-minute access token.
 */
export function authenticate(config: Config, verifier: AccessTokenVerifier | undefined, log: Logger): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = config.serviceToken;
    const inHeader = !!token && matches(c.req.header(SERVICE_TOKEN_HEADER), token);
    const inAuthorization = !!token && matches(c.req.header("authorization"), token);
    if (!inHeader && !inAuthorization) return c.json({ error: "unauthorized" }, 401);

    if (config.auth.mode === "dev") {
      c.set("caller", { principal: undefined, orgId: undefined, via: "service" });
      return next();
    }
    if (!inHeader) {
      c.set("caller", { principal: "service", orgId: undefined, via: "service" });
      return next();
    }
    const jwt = bearer(c.req.header("authorization"));
    if (!jwt || !verifier) return c.json({ error: "sign in required" }, 401);
    let claims: AccessClaims | null;
    try {
      claims = await verifier.verify(jwt);
    } catch (err) {
      // JWKS unreachable or similar: not the person's fault, so not a 401 (that would sign them out).
      log.warn({ err: sanitizeError(String(err)) }, "access token verification unavailable");
      return c.json({ error: "identity provider unavailable; retry in a moment" }, 503);
    }
    if (!claims?.sub) return c.json({ error: "invalid or expired access token" }, 401);
    c.set("caller", { principal: `user:${claims.sub}`, orgId: claims.org_id, via: "user" });
    return next();
  };
}
