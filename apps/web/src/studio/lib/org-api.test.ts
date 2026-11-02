import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { ApiError } from "./projects-api";
import { auditCsvUrl, fetchAudit, orgKeys, orgMutations, orgQueries, sessionCan, stepUpUrl } from "./org-api";

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
let respond: (c: Call) => Response;

const json = (status: number, body: unknown) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  calls = [];
  respond = () => json(404, { detail: "Not Found" });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const c = { url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    return respond(c);
  });
});
afterEach(() => vi.unstubAllGlobals());

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

describe("org-api queries", () => {
  it("unwraps list envelopes from the contract routes", async () => {
    const member = { id: "om_1", userId: "user:u1", name: "A", email: "a@x.org", role: "admin", status: "active", projects: 2, lastActive: null, sso: false };
    respond = (c) => (c.url === "/api/v1/org/members" ? json(200, { members: [member] }) : json(404, {}));
    expect(await client().fetchQuery(orgQueries.members())).toEqual([member]);
  });

  it("project members and API keys hit their routes", async () => {
    respond = (c) => (c.url.endsWith("/members") ? json(200, { members: [] }) : json(200, { keys: [{ id: "k1" }] }));
    const qc = client();
    expect(await qc.fetchQuery(orgQueries.projectMembers("p 1"))).toEqual([]);
    expect(await qc.fetchQuery(orgQueries.apiKeys())).toEqual([{ id: "k1" }]);
    expect(calls.map((c) => c.url)).toEqual(["/api/v1/projects/p%201/members", "/api/v1/org/api-keys"]);
  });

  it("a failed call throws the API's detail (WorkOS text passes through)", async () => {
    respond = () => json(400, { detail: "Invitations to gmail.com must match the address exactly." });
    await expect(client().fetchQuery(orgQueries.invitations())).rejects.toThrow("Invitations to gmail.com must match the address exactly.");
  });

  it("audit pages carry filters, cursor and limit; the CSV link keeps the filters", async () => {
    respond = () => json(200, { events: [], next: null });
    await fetchAudit({ action: "api_key.created", actor: "" }, "ae_9");
    expect(calls[0].url).toBe("/api/v1/org/audit?action=api_key.created&before=ae_9&limit=50");
    expect(auditCsvUrl({ action: "member.removed" })).toBe("/api/v1/org/audit.csv?action=member.removed");
    expect(auditCsvUrl()).toBe("/api/v1/org/audit.csv");
  });

  it("the auth session is read from /api/auth/session", async () => {
    respond = () => json(200, { permissions: ["audit:read"] });
    const s = await client().fetchQuery(orgQueries.authSession());
    expect(calls[0].url).toBe("/api/auth/session");
    expect(sessionCan(s, "audit:read")).toBe(true);
    expect(sessionCan(s, "org:manage")).toBe(false);
    // No session (seed mode, request failed): allowed, the API enforces.
    expect(sessionCan(undefined, "org:manage")).toBe(true);
  });
});

describe("org-api mutations", () => {
  const run = async <V, R>(qc: QueryClient, opts: { mutationFn: (v: V) => Promise<R>; onSuccess?: (r: R) => unknown }, v: V) => new MutationObserver(qc, opts).mutate(v);

  it("inviting posts the contract body and refreshes invitations, members and the audit log", async () => {
    respond = () => json(200, { invitations: [{ id: "inv_1" }] });
    const qc = client();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const out = await run(qc, orgMutations.invite(qc), { emails: ["a@x.org"], role: "member", projects: [{ projectId: "p1", role: "annotator" }] });
    expect(out).toEqual([{ id: "inv_1" }]);
    expect(calls[0]).toEqual({ url: "/api/v1/org/invitations", method: "POST", body: { emails: ["a@x.org"], role: "member", projects: [{ projectId: "p1", role: "annotator" }] } });
    const keys = spy.mock.calls.map((c) => c[0]?.queryKey);
    expect(keys).toEqual(expect.arrayContaining([orgKeys.invitations(), orgKeys.members(), ["org", "audit"]]));
  });

  it("role changes and removals use the membership id; deletes accept 204", async () => {
    respond = (c) => (c.method === "DELETE" ? json(204, null) : json(200, { id: "om_1", role: "billing" }));
    const qc = client();
    await run(qc, orgMutations.setRole(qc), { id: "om_1", role: "billing" });
    await run(qc, orgMutations.removeMember(qc), "om_1");
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ["PATCH", "/api/v1/org/members/om_1", { role: "billing" }],
      ["DELETE", "/api/v1/org/members/om_1", undefined],
    ]);
  });

  it("project member writes refresh that project's members", async () => {
    respond = () => json(200, { projectId: "p1", userId: "user:u2", role: "reviewer" });
    const qc = client();
    const spy = vi.spyOn(qc, "invalidateQueries");
    await run(qc, orgMutations.addToProject(qc, "p1"), { userId: "user:u2", role: "reviewer" });
    expect(calls[0]).toEqual({ url: "/api/v1/projects/p1/members", method: "POST", body: { userId: "user:u2", role: "reviewer" } });
    expect(spy.mock.calls.map((c) => c[0]?.queryKey)).toContainEqual(orgKeys.projectMembers("p1"));
  });

  it("patching the org stores the answer in the cache", async () => {
    const org = { id: "o1", workosOrgId: null, name: "Lab", createdAt: "2026-01-01T00:00:00Z", zeroRetention: true, aiAssist: false, domains: [] };
    respond = () => json(200, org);
    const qc = client();
    await run(qc, orgMutations.patchOrg(qc), { name: "Lab" });
    expect(calls[0]).toMatchObject({ url: "/api/v1/org", method: "PATCH", body: { name: "Lab" } });
    expect(qc.getQueryData(orgKeys.settings())).toEqual(org);
  });

  it("key creation returns the secret once; a stale sign-in surfaces the step-up URL", async () => {
    respond = () => json(200, { key: { id: "k1" }, secret: "sk_123" });
    const qc = client();
    const r = await run(qc, orgMutations.createKey(qc), { name: "PACS", expiresInDays: 90, scopes: ["datasets:read"] });
    expect(r.secret).toBe("sk_123");
    expect(calls[0].body).toEqual({ name: "PACS", expiresInDays: 90, scopes: ["datasets:read"] });

    respond = () => json(403, { detail: "step_up_required", loginUrl: "/api/auth/login?max_age=600&return_to=%2Forganization%2Fapi-keys" });
    const err = await run(qc, orgMutations.createKey(qc), { name: "PACS", expiresInDays: null, scopes: [] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(stepUpUrl(err)).toBe("/api/auth/login?max_age=600&return_to=%2Forganization%2Fapi-keys");
    expect(stepUpUrl(new ApiError(403, "Forbidden", { detail: "Forbidden" }))).toBeNull();
  });

  it("MFA policy, Admin Portal and sessions", async () => {
    respond = (c) =>
      c.url.endsWith("/admin-portal") ? json(200, { url: "https://portal.example/x" }) : c.url.endsWith("/security") ? json(200, { mfaRequired: true }) : json(204, null);
    const qc = client();
    await run(qc, orgMutations.setMfa(qc), true);
    expect(qc.getQueryData(orgKeys.security())).toEqual({ mfaRequired: true });
    expect(await run(qc, orgMutations.adminPortal(qc), "sso")).toBe("https://portal.example/x");
    await run(qc, orgMutations.revokeSession(qc), "sess_2");
    await run(qc, orgMutations.revokeOtherSessions(qc), undefined);
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ["PATCH", "/api/v1/org/security", { mfaRequired: true }],
      ["POST", "/api/v1/org/admin-portal", { intent: "sso" }],
      ["DELETE", "/api/v1/me/sessions/sess_2", undefined],
      ["POST", "/api/v1/me/sessions/revoke-others", undefined],
    ]);
  });
});
