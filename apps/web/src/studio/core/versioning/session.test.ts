import { afterEach, describe, expect, it, vi } from "vitest";
import type { Annotation } from "@studio/plugin-contracts/types";
import { diffPreviewFor } from "@/extension-host/trusted-renderers";
import { loadDocument, reapply, saveVersioned, StaleHeadError, useVersioning } from "./session";
import { registerBuiltinPreviews } from "./previews";

const a = (id: string, x = 1): Annotation => ({ id, itemId: "img/a.png", label: "lesion", geometry: { type: "box", x, y: 1, w: 2, h: 2 }, provenance: "human-created", author: "user:a", createdAt: "2026-10-30T00:00:00Z" });

afterEach(() => {
  vi.unstubAllGlobals();
  useVersioning.setState({ enabled: false, datasetId: null, branch: null, head: null, base: [], stale: null, readOnly: false });
});

describe("versioned save flow", () => {
  it("is off without the kernel: the plain document loads and nothing is fetched", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const fallback = vi.fn(async () => ({ revision: 3, annotations: [a("p")] }));
    const doc = await loadDocument("ds-off", fallback);
    expect(doc.revision).toBe(3);
    expect(fallback).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    expect(useVersioning.getState().enabled).toBe(false);
  });

  it("saves as a commit with expected_head and advances the head", async () => {
    useVersioning.setState({ enabled: true, datasetId: "ds", branch: "work/user-a/ds", head: "a".repeat(40) });
    const fetch = vi.fn(async () => new Response(JSON.stringify({ commit_oid: "b".repeat(40), branch: "work/user-a/ds", head_generation: 7, manifest_root: "sha256:x" }), { status: 201 }));
    vi.stubGlobal("fetch", fetch);
    expect(await saveVersioned("ds", [a("1")])).toBe(7);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/datasets/ds/commits");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ branch: "work/user-a/ds", expected_head: "a".repeat(40), document: { annotations: [a("1")] } });
    expect(useVersioning.getState().head).toBe("b".repeat(40));
  });

  it("turns a 409 stale_head into 'someone else saved'", async () => {
    useVersioning.setState({ enabled: true, datasetId: "ds", branch: "work/user-a/ds", head: "a".repeat(40) });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: 409, code: "stale_head", detail: "the branch moved", current_head: "c".repeat(40) }), { status: 409 })));
    await expect(saveVersioned("ds", [a("1")])).rejects.toBeInstanceOf(StaleHeadError);
    expect(useVersioning.getState().stale).toEqual({ currentHead: "c".repeat(40) });
  });

  it("never saves to a protected branch", async () => {
    useVersioning.setState({ enabled: true, datasetId: "ds", branch: "main", head: "a".repeat(40), readOnly: true });
    await expect(saveVersioned("ds", [])).rejects.toThrow(/protected/);
  });

  it("re-applies this session's edits onto a fresher document", () => {
    const base = [a("keep"), a("edit"), a("drop")];
    const mine = [a("keep"), a("edit", 9), a("new")];
    const fresh = [a("keep", 5), a("edit", 2), a("drop"), a("theirs")];
    expect(reapply(base, mine, fresh)).toEqual([a("keep", 5), a("edit", 9), a("theirs"), a("new")]);
  });
});

describe("diffPreview registry", () => {
  it("serves the built-in shape preview for boxes and polygons only", () => {
    registerBuiltinPreviews();
    expect(diffPreviewFor("box")?.description).toMatch(/before/);
    expect(diffPreviewFor("polygon")).toBe(diffPreviewFor("box"));
    expect(diffPreviewFor("mask")).toBeUndefined();
  });
});
