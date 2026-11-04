import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Annotation } from "@studio/contracts";
import { bindHost, host, HostProvider, type HostListener, type StudioHost, type StudioHostState } from "@studio/plugin-ui-sdk";
import { MaskReview } from "./MaskReview";

/**
 * `studio.mask-review.v1` against a hand-written host (no Zustand, no shell): it lists the
 * item's machine-made masks with provider, model and confidence, and accept / reject /
 * edit write canonical annotation edits (review_status, hidden), never deletions.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mask = (id: string, extra: Partial<Annotation> = {}): Annotation => ({
  id,
  itemId: "img/a.png",
  label: "cell",
  geometry: { type: "mask", dims: [2, 2], counts: [0, 4] },
  provenance: "ai-suggested",
  author: "plugin:seg@1.0.0",
  createdAt: "2026-10-30T00:00:00Z",
  attributes: { provider: "mock", model: "mock-1", review_status: "pending", confidence: 0.87 },
  ...extra,
});

function fakeHost(annotations: Annotation[]) {
  const calls: { op: string; args: unknown[] }[] = [];
  const listeners = new Set<HostListener>();
  let state: StudioHostState;
  const set = (patch: Partial<StudioHostState>) => {
    const prev = state;
    state = { ...state, ...patch };
    listeners.forEach((l) => l(state, prev));
  };
  const applyPatch = (id: string, patch: Partial<Annotation>) => set({ annotations: state.annotations.map((a) => (a.id === id ? { ...a, ...patch } : a)) });
  state = {
    annotations,
    selectedId: null,
    tool: "select",
    update: (id: string, patch: Partial<Annotation>) => (calls.push({ op: "update", args: [id, patch] }), applyPatch(id, patch)),
    batch: (b: { update: { id: string; patch: Partial<Annotation> }[] }) => (calls.push({ op: "batch", args: [b] }), b.update.forEach((u) => applyPatch(u.id, u.patch))),
    select: (id: string) => (calls.push({ op: "select", args: [id] }), set({ selectedId: id })),
    setTool: (t: string) => (calls.push({ op: "setTool", args: [t] }), set({ tool: t })),
    remove: (...args: unknown[]) => calls.push({ op: "remove", args }),
  } as unknown as StudioHostState;
  const noop = () => {};
  const commands: { map: Record<string, () => unknown>; scope?: unknown }[] = [];
  const h: StudioHost = {
    store: { getState: () => state, subscribe: (l) => (listeners.add(l), () => listeners.delete(l)) },
    assetUrl: (p) => p,
    useCommands: ((map: Record<string, () => unknown>, opts?: { scope?: unknown }) => commands.push({ map, scope: opts?.scope })) as never,
    useHotkeys: noop,
    execute: () => false,
    registerCommand: () => noop,
    commandDef: () => undefined,
    commandId: (n) => n,
    describeGeometry: (a) => a.geometry.type,
    inspectRows: () => [],
    resolveSpec: () => ({ errors: [] }) as never,
  };
  return { h, calls, state: () => state, commands: () => commands.at(-1)! };
}

const env = (tools: string[] = ["brush"]) => ({ labels: [{ name: "cells", control: "BrushLabels", classes: [{ id: "cell" }] }], tools: tools.map((name) => ({ name })) });
const item = { id: "img/a.png", name: "a.png", group: "Images", assets: [{ path: "img/a.png" }] };

describe("MaskReview (studio.mask-review.v1)", () => {
  let el: HTMLDivElement;
  let root: Root;
  let previous: StudioHost | null = null;

  beforeEach(() => {
    try {
      previous = host();
    } catch {
      previous = null;
    }
    el = document.createElement("div");
    document.body.append(el);
    root = createRoot(el);
  });
  afterEach(() => {
    act(() => root.unmount());
    el.remove();
    if (previous) bindHost(previous);
  });

  function render(annotations: Annotation[], props: Record<string, unknown> = {}) {
    const fake = fakeHost(annotations);
    bindHost(fake.h);
    act(() => root.render(createElement(HostProvider, { host: fake.h }, createElement(MaskReview as never, { env: env(), item, config: {}, ...props } as never))));
    return fake;
  }
  const button = (label: string) => el.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  const click = (b: HTMLElement) => act(() => b.dispatchEvent(new MouseEvent("click", { bubbles: true })));

  it("lists only this item's machine-made masks, with provider, model and confidence", () => {
    render([
      mask("m1"),
      mask("m2", { itemId: "img/other.png" }),
      mask("h1", { provenance: "human-created", author: "alice", attributes: {} }),
      mask("b1", { geometry: { type: "box", x: 0, y: 0, w: 1, h: 1 } }),
    ]);
    const rows = [...el.querySelectorAll("[data-mask]")].map((r) => r.getAttribute("data-mask"));
    expect(rows).toEqual(["m1"]);
    expect(el.textContent).toContain("mock · mock-1 · 87%");
    expect(el.textContent).toContain("1 to review");
  });

  it("shows human masks too when onlySuggested is off, and an empty state when there are none", () => {
    render([mask("h1", { provenance: "human-created", author: "alice", attributes: {} })], { config: { onlySuggested: false } });
    expect(el.querySelectorAll("[data-mask]").length).toBe(1);
    act(() => root.render(createElement(MaskReview as never, { env: env(), item: { ...item, id: "img/none.png" }, config: {} } as never)));
    expect(el.textContent).toContain("No masks yet");
  });

  it("accept and reject write review_status and visibility, never delete", () => {
    const fake = render([mask("m1"), mask("m2", { label: "nucleus" })]);
    click(button("Accept cell"));
    expect(fake.calls.at(-1)).toEqual({ op: "update", args: ["m1", { attributes: expect.objectContaining({ review_status: "accepted", provider: "mock" }), hidden: false }] });
    expect(button("Accept cell").disabled).toBe(true);
    click(button("Reject nucleus"));
    expect(fake.state().annotations.find((a) => a.id === "m2")).toMatchObject({ hidden: true, attributes: { review_status: "rejected" } });
    expect(fake.state().annotations).toHaveLength(2);
    expect(fake.calls.some((c) => c.op === "remove")).toBe(false);
  });

  it("edit marks the mask edited, selects it and switches to the brush", () => {
    const fake = render([mask("m1")]);
    click(button("Edit cell"));
    expect(fake.calls.map((c) => c.op)).toEqual(["update", "select", "setTool"]);
    expect(fake.state()).toMatchObject({ selectedId: "m1", tool: "brush" });
    expect(fake.state().annotations[0].attributes?.review_status).toBe("edited");
  });

  it("offers Edit only when the environment has a brush", () => {
    const fake = fakeHost([mask("m1")]);
    bindHost(fake.h);
    act(() => root.render(createElement(HostProvider, { host: fake.h }, createElement(MaskReview as never, { env: env([]), item, config: {} } as never))));
    expect(button("Edit cell")).toBeNull();
  });

  it("Accept and Reject review every pending mask on this item in one batch", () => {
    const fake = render([mask("m1"), mask("m2"), mask("m3", { attributes: { provider: "mock", review_status: "rejected" } }), mask("o1", { itemId: "img/other.png" })]);
    expect(el.textContent).toContain("2 to review");
    click(el.querySelector<HTMLButtonElement>('[data-testid="mask-accept-item"]')!);
    expect(fake.calls.filter((c) => c.op === "batch")).toHaveLength(1);
    expect(fake.state().annotations.map((a) => a.attributes?.review_status)).toEqual(["accepted", "accepted", "rejected", "pending"]);
    expect(el.textContent).toContain("0 to review");
  });

  it("Accept all accepts pending masks on every item; shown only when other items have some", () => {
    const fake = render([mask("m1"), mask("o1", { itemId: "img/other.png" }), mask("o2", { itemId: "img/other.png", attributes: { provider: "mock", review_status: "rejected" } })]);
    click(el.querySelector<HTMLButtonElement>('[data-testid="mask-accept-all"]')!);
    expect(fake.state().annotations.map((a) => a.attributes?.review_status)).toEqual(["accepted", "accepted", "rejected"]);
    expect(el.querySelector('[data-testid="mask-accept-all"]')).toBeNull();
  });

  it("binds its keyboard commands under the plugin's scope: accept / reject this item, accept all", () => {
    const fake = render([mask("m1"), mask("m2", { label: "nucleus" }), mask("o1", { itemId: "img/other.png" })], { pluginId: "studio.segmentation" });
    expect(fake.commands().scope).toBe("studio.segmentation");
    expect(Object.keys(fake.commands().map).sort()).toEqual(["acceptAllMasks", "acceptItemMasks", "rejectItemMasks"]);
    act(() => void fake.commands().map.rejectItemMasks());
    expect(fake.state().annotations.filter((a) => a.itemId === item.id).every((a) => a.hidden && a.attributes?.review_status === "rejected")).toBe(true);
    expect(fake.commands().map.rejectItemMasks()).toBe(false); // nothing left to review: the key falls through
    act(() => void fake.commands().map.acceptAllMasks());
    expect(fake.state().annotations.find((a) => a.id === "o1")?.attributes?.review_status).toBe("accepted");
  });
});
