import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/studio/lib/projects-api", async (orig) => ({ ...(await orig<object>()), fetchProject: async () => ({ attested: false }) }));

import { useUploads } from "@/studio/stores/uploads";
import { importFromLink, linkOk } from "./import-link-dialog";

describe("todo18 Import from a link", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("accepts https and gs links only", () => {
    expect(linkOk("https://example.com/a.png")).toBe(true);
    expect(linkOk("gs://bucket/a.dcm")).toBe(true);
    expect(linkOk("http://example.com/a.png")).toBe(false);
    expect(linkOk("file:///etc/passwd")).toBe(false);
  });
  it("asks the same rights attestation, then posts the link attested", async () => {
    const calls: { url: string; body?: string }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      calls.push({ url: String(url), body: init.body as string });
      return new Response(JSON.stringify({ importId: "imp1", state: "fetching" }), { status: 202, headers: { "Content-Type": "application/json" } });
    });
    const p = importFromLink("p1", " https://example.com/a.png ", "fld1");
    await vi.waitFor(() => expect(useUploads.getState().attestation).toMatchObject({ projectId: "p1", count: 1 }));
    expect(calls).toHaveLength(0);
    useUploads.getState().answerAttestation(true);
    expect(await p).toMatchObject({ importId: "imp1" });
    expect(calls[0].url).toMatch(/\/v1\/projects\/p1\/imports\/url$/);
    expect(JSON.parse(calls[0].body!)).toEqual({ url: "https://example.com/a.png", attested: true, folderId: "fld1" });
  });
  it("declining the attestation sends nothing", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const p = importFromLink("p1", "https://example.com/a.png");
    await vi.waitFor(() => expect(useUploads.getState().attestation).not.toBeNull());
    useUploads.getState().answerAttestation(false);
    expect(await p).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});
