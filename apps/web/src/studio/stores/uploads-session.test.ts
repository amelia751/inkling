import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/studio/lib/uploads/hash", () => ({ hashFiles: async (files: File[]) => files.map((_, i) => `sha${i}`) }));
vi.mock("@/studio/lib/projects-api", async (orig) => ({ ...(await orig<object>()), fetchProject: async () => ({ attested: false }) }));
const signIn = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@/studio/lib/session", async (orig) => ({ ...(await orig<object>()), signInAgain: () => void signIn.calls++ }));

import { LEAVE_REASONS, useUploads } from "./uploads";

const picked = (n: number) => ({ files: Array.from({ length: n }, (_, i) => ({ relPath: `a/${i}.png`, file: new File(["x"], `${i}.png`) })), skipped: 0 });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("todo18 D7 leaving stops uploads", () => {
  let calls: { url: string; method: string }[];
  beforeEach(() => {
    calls = [];
    signIn.calls = 0;
    useUploads.setState({ sessions: [], attestation: null, attestationQueue: [] });
  });
  afterEach(() => vi.unstubAllGlobals());

  const stub = (chunk: () => Response) =>
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      calls.push({ url: String(url), method: init.method ?? "GET" });
      if (/\/imports$/.test(String(url))) return json(200, { id: "imp1", state: "uploading", files: [{ clientFileId: "f0", relPath: "a/0.png", size: 1, received: 0, state: "pending", reason: null }] });
      if (/\/uploads\//.test(String(url))) return chunk();
      if (/cancel/.test(String(url))) return json(200, { id: "imp1", state: "cancelled" });
      return json(200, {});
    });

  it("a 401 on a chunk PUT stops the session at once (no retries), cancels on the kernel and says so", async () => {
    stub(() => json(401, { detail: "unauthorized" }));
    const p = useUploads.getState().add("p1", picked(1));
    await vi.waitFor(() => expect(useUploads.getState().attestation).not.toBeNull());
    useUploads.getState().answerAttestation(true);
    const s = await p;
    expect(calls.filter((c) => /\/uploads\//.test(c.url))).toHaveLength(1);
    expect(calls.some((c) => /imports\/imp1\/cancel/.test(c.url) && c.method === "POST")).toBe(true);
    expect(s?.phase).toBe("cancelled");
    expect(s?.error).toBe(LEAVE_REASONS.unauthorized);
    expect(signIn.calls).toBe(1);
  });

  it("sign-out aborts uploads waiting on the rights dialog and says why", async () => {
    stub(() => json(200, {}));
    const p = useUploads.getState().add("p1", picked(2));
    await vi.waitFor(() => expect(useUploads.getState().attestation).not.toBeNull());
    expect(await useUploads.getState().abortAll("signedOut")).toBe(1);
    const s = await p;
    expect(s?.phase).toBe("cancelled");
    expect(s?.error).toBe(LEAVE_REASONS.signedOut);
    expect(useUploads.getState().attestation).toBeNull();
  });

  it("two uploads into one project share one rights dialog with both counts; another project queues", async () => {
    stub(() => json(200, { state: "uploaded", received: 1 }));
    const a = useUploads.getState().add("p1", picked(2));
    await vi.waitFor(() => expect(useUploads.getState().attestation?.count).toBe(2));
    const b = useUploads.getState().add("p1", picked(3));
    const c = useUploads.getState().add("p2", picked(1));
    await vi.waitFor(() => expect(useUploads.getState().attestation?.count).toBe(5));
    await vi.waitFor(() => expect(useUploads.getState().attestationQueue).toHaveLength(1));
    useUploads.getState().answerAttestation(false);
    expect((await a)?.phase).toBe("cancelled");
    expect((await b)?.phase).toBe("cancelled");
    expect(useUploads.getState().attestation).toMatchObject({ projectId: "p2", count: 1 });
    useUploads.getState().answerAttestation(false);
    expect((await c)?.phase).toBe("cancelled");
  });
});
