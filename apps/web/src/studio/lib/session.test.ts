import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/extension-host/http";
import { applyRuntimeConfig } from "@/extension-host/runtime-config";
import { ACCOUNT, ORG } from "@/studio/lib/account-mock";
import { useStudio } from "@/studio/stores/studio";
import { browser, can, fetchSession, installSessionHandlers, loginUrl, mockSession, onBeforeSignIn, PERMISSIONS, resetForOrg, sessionCaches, sessionKey, signInAgain, SignedOutError, switchOrg, useSignIn, type Session } from "./session";
import { stashUnsaved, takeUnsaved } from "./unsaved";

const SESSION: Session = {
  mode: "workos",
  user: { id: "user:user_01", workosUserId: "user_01", email: "ada@example.org", firstName: "Ada", lastName: "L", name: "Ada L", avatarUrl: null },
  organization: { id: "org_a", workosOrgId: "org_01A", name: "Acme" },
  role: "member",
  permissions: ["project:create"],
  organizations: [{ id: "org_a", workosOrgId: "org_01A", name: "Acme" }, { id: "org_b", workosOrgId: "org_01B", name: "Beta" }],
  impersonator: null,
  expiresAt: null,
};

const fetchMock = vi.fn<typeof fetch>();
let uninstall: () => void = () => undefined;

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  useSignIn.setState({ redirecting: false });
  window.history.replaceState(null, "", "/projects/p1/studio/t1?item=3");
  uninstall = installSessionHandlers();
});

afterEach(() => {
  uninstall();
  vi.unstubAllGlobals();
  applyRuntimeConfig(null);
  sessionStorage.clear();
});

const unauthorized = () => new Response(JSON.stringify({ detail: "Not signed in" }), { status: 401, headers: { "content-type": "application/json" } });

describe("session", () => {
  it("is the mock account in seed mode, without asking anyone", async () => {
    applyRuntimeConfig({ auth: { mode: "dev" }, kernel: false });
    const s = await fetchSession();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(s).toMatchObject({ mode: "dev", user: { name: ACCOUNT.name, email: ACCOUNT.email, workosUserId: ACCOUNT.id }, organization: { id: ORG.id, name: ORG.name } });
    expect(s.permissions).toEqual([...PERMISSIONS]);
    expect(s.organizations).toHaveLength(1);
  });

  it("asks the API in dev mode with a kernel, and falls back to the mock account when it can't answer", async () => {
    applyRuntimeConfig({ auth: { mode: "dev" }, kernel: true });
    fetchMock.mockResolvedValueOnce(Response.json({ ...SESSION, mode: "dev" }));
    expect((await fetchSession()).user.email).toBe("ada@example.org");
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/auth/session");

    fetchMock.mockResolvedValueOnce(new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } }));
    expect((await fetchSession()).user.name).toBe(ACCOUNT.name);
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 404 }));
    expect((await fetchSession()).user.name).toBe(ACCOUNT.name);
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    expect((await fetchSession()).user.name).toBe(ACCOUNT.name);
    // A 401 in dev mode never redirects.
    fetchMock.mockResolvedValueOnce(unauthorized());
    expect((await fetchSession()).user.name).toBe(ACCOUNT.name);
    expect(useSignIn.getState().redirecting).toBe(false);
  });

  it("can() reads the session's permissions", () => {
    expect(can(SESSION, "project:create")).toBe(true);
    expect(can(SESSION, "members:manage")).toBe(false);
    expect(can(undefined, "project:create")).toBe(false);
    expect(PERMISSIONS.every((p) => can(mockSession(), p))).toBe(true);
  });
});

describe("signing in again (workos mode)", () => {
  beforeEach(() => applyRuntimeConfig({ auth: { mode: "workos" }, kernel: true }));

  it("a 401 from /api/auth/session goes to the login page, back to the same path and query", async () => {
    const assign = vi.spyOn(browser, "assign").mockImplementation(() => undefined);
    fetchMock.mockResolvedValueOnce(unauthorized());
    await expect(fetchSession()).rejects.toBeInstanceOf(SignedOutError);
    expect(useSignIn.getState().redirecting).toBe(true);
    expect(assign).toHaveBeenCalledWith(`/api/auth/login?return_to=${encodeURIComponent("/projects/p1/studio/t1?item=3")}`);
    vi.restoreAllMocks();
  });

  it("redirects once, after the before-sign-in hooks", () => {
    const order: string[] = [];
    const off = onBeforeSignIn(() => order.push("hook"));
    const go = vi.fn(() => order.push("go"));
    signInAgain(go);
    signInAgain(go);
    off();
    expect(order).toEqual(["hook", "go"]);
    expect(go).toHaveBeenCalledWith(loginUrl("/projects/p1/studio/t1?item=3"));
  });

  it("never redirects in dev mode", () => {
    applyRuntimeConfig({ auth: { mode: "dev" } });
    const go = vi.fn();
    signInAgain(go);
    expect(go).not.toHaveBeenCalled();
  });

  it("a query or mutation failing with 401 sends the person to sign in", () => {
    const assign = vi.spyOn(browser, "assign").mockImplementation(() => undefined);
    const { queryCache } = sessionCaches();
    queryCache.config.onError?.(new Error("boom"), {} as never);
    expect(assign).not.toHaveBeenCalled();
    queryCache.config.onError?.(Object.assign(new Error("401"), { status: 401 }), {} as never);
    expect(assign).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it("keeps the open Studio's unsaved annotations across the redirect", () => {
    const annotations = [{ id: "a1", itemId: "i1", label: "x", geometry: { type: "class" }, provenance: "human-created", author: "me", createdAt: "2026-01-01T00:00:00Z" }] as never;
    useStudio.setState({ projectId: "t1", dirty: true, revision: 7, annotations });
    const off = onBeforeSignIn(stashUnsaved);
    signInAgain(() => undefined);
    off();
    expect(takeUnsaved("t1")).toEqual({ revision: 7, annotations });
    expect(takeUnsaved("t1")).toBeNull();
    useStudio.setState({ projectId: null, dirty: false, revision: 0, annotations: [] });
  });
});

describe("shared fetch", () => {
  it("sends the cookie and the CSRF header, keeping the caller's headers", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({}));
    await apiFetch("/api/v1/projects", { method: "POST", headers: { "Content-Type": "application/json" } });
    const init = fetchMock.mock.calls[0][1]!;
    const headers = new Headers(init.headers);
    expect(init.credentials).toBe("same-origin");
    expect(headers.get("X-Requested-With")).toBe("fetch");
    expect(headers.get("Content-Type")).toBe("application/json");
  });
});

describe("organizations", () => {
  it("switch-org passes a redirect through, else reports ok", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ ok: true }));
    expect(await switchOrg("org_b")).toEqual({});
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]!.body))).toEqual({ organizationId: "org_b" });
    fetchMock.mockResolvedValueOnce(Response.json({ redirect: "https://auth.example.test/authorize" }));
    expect(await switchOrg("org_b")).toEqual({ redirect: "https://auth.example.test/authorize" });
  });

  it("after a switch only the new session stays cached", async () => {
    applyRuntimeConfig({ auth: { mode: "workos" }, kernel: true });
    const client = new QueryClient();
    client.setQueryData(sessionKey, SESSION);
    client.setQueryData(["projects", "list"], [{ id: "p1" }]);
    fetchMock.mockResolvedValueOnce(Response.json({ ...SESSION, organization: SESSION.organizations[1] }));
    await resetForOrg(client);
    expect(client.getQueryData<Session>(sessionKey)?.organization.id).toBe("org_b");
    expect(client.getQueryData(["projects", "list"])).toBeUndefined();
  });
});
