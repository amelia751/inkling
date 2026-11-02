import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";

type Key = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { workosVerifier } from "../../src/http/auth.ts";
import { TOKEN, harness } from "./harness.ts";

/**
 * todo9 Phase 5: the agent accepts the shared service token plus, in `workos` mode, a WorkOS access
 * token verified against the client's JWKS. A local JWKS server stands in for WorkOS (no network).
 */
const CLIENT_ID = "client_test123";
const ISSUER = "https://api.workos.com/user_management/client_test123";

let server: Server;
let baseUrl: string;
let key: Key;
let otherKey: Key;
let jwksHits = 0;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  key = pair.privateKey;
  otherKey = (await generateKeyPair("RS256")).privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  server = createServer((req, res) => {
    if (req.url === `/sso/jwks/${CLIENT_ID}`) {
      jwksHits++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [jwk] }));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

/** A WorkOS-shaped user access token. */
async function accessToken(claims: Record<string, unknown> = {}, opts: { signWith?: Key; expiresIn?: string; issuer?: string } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sid: "session_1", auth_time: now, org_id: "org_a", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setSubject((claims.sub as string) ?? "user_alice")
    .setIssuer(opts.issuer ?? ISSUER)
    .setIssuedAt(now - 5)
    .setExpirationTime(opts.expiresIn ?? "5m")
    .sign(opts.signWith ?? key);
}

describe("WorkOS access-token verifier (SDK, client id only)", () => {
  const verifier = () => workosVerifier({ clientId: CLIENT_ID, issuer: ISSUER, baseUrl });

  it("returns the claims of a valid user access token", async () => {
    expect(await verifier().verify(await accessToken())).toMatchObject({ sub: "user_alice", org_id: "org_a", sid: "session_1" });
    expect(jwksHits).toBeGreaterThan(0);
  });

  it("rejects bad signatures, expired tokens, other issuers and non-user tokens", async () => {
    const v = verifier();
    expect(await v.verify(await accessToken({}, { signWith: otherKey }))).toBeNull();
    expect(await v.verify(await accessToken({}, { expiresIn: "-1m" }))).toBeNull();
    expect(await v.verify(await accessToken({}, { issuer: "https://evil.example" }))).toBeNull();
    // Widget/agent tokens share the signing key but aren't user access tokens.
    expect(await v.verify(await accessToken({ sub_type: "widget" }))).toBeNull();
    expect(await v.verify("not-a-jwt")).toBeNull();
  });

  it("throws (not null) when the JWKS can't be fetched", async () => {
    const v = workosVerifier({ clientId: "client_missing", issuer: undefined, baseUrl: "http://127.0.0.1:9" });
    await expect(v.verify(await accessToken())).rejects.toThrow();
  });
});

type H = Awaited<ReturnType<typeof harness>>;
let h: H | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const workosMode = () => harness({ scripts: [] }, { AGENT_AUTH_MODE: "workos", AGENT_WORKOS_CLIENT_ID: CLIENT_ID, AGENT_WORKOS_ISSUER: ISSUER, AGENT_WORKOS_BASE_URL: baseUrl });
/** Headers the web proxy sends in workos mode. */
const asUser = async (claims: Record<string, unknown> = {}) => ({ "x-agent-service-token": TOKEN, authorization: `Bearer ${await accessToken(claims)}` });

describe("workos auth mode", () => {
  it("needs the service token and a valid access token", async () => {
    h = await workosMode();
    expect((await h.app.request("/v1/status")).status).toBe(401);
    // Access token without the service token: the ingress stays closed.
    expect((await h.app.request("/v1/status", { headers: { authorization: `Bearer ${await accessToken()}` } })).status).toBe(401);
    // Service token in its header but no person.
    expect((await h.app.request("/v1/status", { headers: { "x-agent-service-token": TOKEN } })).status).toBe(401);
    expect((await h.app.request("/v1/status", { headers: { "x-agent-service-token": TOKEN, authorization: "Bearer junk" } })).status).toBe(401);
    expect((await h.app.request("/v1/status", { headers: { "x-agent-service-token": "wrong", authorization: `Bearer ${await accessToken()}` } })).status).toBe(401);
    expect((await h.app.request("/v1/status", { headers: await asUser() })).status).toBe(200);
  });

  it("scopes sessions to the verified user and organization", async () => {
    h = await workosMode();
    const hh = h;
    const create = async (claims: Record<string, unknown>) => {
      const res = await hh.call("POST", "/v1/sessions", { projectId: "demo", profile: "assistant" }, await asUser(claims));
      expect(res.status).toBe(201);
      return ((await res.json()) as { sessionId: string }).sessionId;
    };
    const list = async (claims: Record<string, unknown>) => {
      const res = await hh.call("GET", "/v1/sessions", undefined, await asUser(claims));
      expect(res.status).toBe(200);
      return ((await res.json()) as { sessions: { id: string }[] }).sessions.map((s) => s.id);
    };
    const alice = { sub: "user_alice", org_id: "org_a" };
    const aliceB = { sub: "user_alice", org_id: "org_b" };
    const bob = { sub: "user_bob", org_id: "org_a" };

    const a1 = await create(alice);
    const b1 = await create(aliceB);
    expect(await list(alice)).toEqual([a1]);
    expect(await list(aliceB)).toEqual([b1]);
    expect(await list(bob)).toEqual([]);

    const meta = await h.sessions.store.getMeta(a1);
    expect(meta).toMatchObject({ owner: "user:user_alice", orgId: "org_a" });

    // Another person, or the same person in another organization, can't open it.
    expect((await h.call("GET", `/v1/sessions/${a1}`, undefined, await asUser(bob))).status).toBe(404);
    expect((await h.call("GET", `/v1/sessions/${a1}`, undefined, await asUser(aliceB))).status).toBe(404);
    expect((await h.call("DELETE", `/v1/sessions/${a1}`, undefined, await asUser(bob))).status).toBe(404);
    expect((await h.call("GET", `/v1/sessions/${a1}`, undefined, await asUser(alice))).status).toBe(200);

    // A service-only call (token in Authorization, no person) sees nobody's sessions.
    const svc = await h.app.request("/v1/sessions", { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(((await svc.json()) as { sessions: unknown[] }).sessions).toEqual([]);
    expect((await h.app.request(`/v1/sessions/${a1}`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(404);
  });

  it("answers 503, not 401, when the JWKS is unreachable", async () => {
    h = await harness({ scripts: [] }, { AGENT_AUTH_MODE: "workos", AGENT_WORKOS_CLIENT_ID: "client_missing", AGENT_WORKOS_BASE_URL: "http://127.0.0.1:9" });
    expect((await h.app.request("/v1/status", { headers: await asUser() })).status).toBe(503);
  });

  it("refuses to start without a client id or service token", async () => {
    await expect(harness({ scripts: [] }, { AGENT_AUTH_MODE: "workos" })).rejects.toThrow(/WORKOS_CLIENT_ID/);
  });
});

describe("dev auth mode", () => {
  it("accepts the service token in either header; everyone is the local principal", async () => {
    h = await harness({ scripts: [] });
    for (const headers of [{ authorization: `Bearer ${TOKEN}` }, { "x-agent-service-token": TOKEN }, { "x-agent-service-token": TOKEN, authorization: "Bearer some-jwt" }])
      expect((await h.app.request("/v1/status", { headers })).status).toBe(200);
    const created = await h.json("POST", "/v1/sessions", { projectId: "demo", profile: "assistant" });
    expect(created.status).toBe(201);
    const listed = await h.app.request("/v1/sessions", { headers: { "x-agent-service-token": TOKEN } });
    expect(((await listed.json()) as { sessions: { id: string }[] }).sessions.map((s) => s.id)).toEqual([created.body.sessionId]);
    expect(await h.sessions.store.getMeta(created.body.sessionId)).toMatchObject({ owner: "local" });
  });
});
