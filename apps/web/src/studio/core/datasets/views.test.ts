import "@/extension-host/host";
import { act, createElement as h, type ComponentType, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatasetCollection, DatasetProfile, DatasetSummary } from "@studio/contracts/types";
import { TooltipProvider } from "@studio/ui/ui/tooltip";
import { ApiError } from "@/studio/lib/projects-api";
import type { ProfileQuery } from "./api";
import type { DatasetViewProps } from "./DatasetLayout";
import { DatasetOverview } from "./DatasetOverview";
import { DatasetStructure } from "./structure/DatasetStructure";
import { FieldsAndFormats } from "./formats/FieldsAndFormats";
import { DatasetQuality } from "./quality/DatasetQuality";
import { DatasetHistory } from "./history/DatasetHistory";
import { AnnotationDefinitions } from "./annotations/AnnotationDefinitions";

/**
 * docs/datasets.md §12.1 and §15 (todo13 Milestone 3 exit tests): every Datasets view has a
 * loading, empty, error and permission-denied state; format is shown apart from fields (4); a
 * viewer can inspect a collection's fields, formats and provenance without edit actions (6); an
 * unknown kind gets the safe generic reading (17); every selectable row is a keyboard control (18).
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView ??= function () {};
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
window.matchMedia ??= ((q: string) => ({ matches: q.includes("min-width"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
async function render(el: ReactElement) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root!.render(h(QueryClientProvider, { client: qc }, h(MemoryRouter, { initialEntries: ["/projects/p/datasets/d"] }, h(TooltipProvider, null, el)))));
  // Let the views' own queries (attention, pipeline, activity) settle.
  await act(async () => new Promise((r) => setTimeout(r, 20)));
}
const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const tid = (id: string) => $(`[data-testid="${id}"]`);

/** Every api call answers 404 (no such route here) unless a test says otherwise. */
let routes: Record<string, () => Response> = {};
beforeEach(() => {
  routes = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const hit = Object.entries(routes).find(([k]) => String(url).includes(k));
      return hit ? hit[1]() : new Response(JSON.stringify({ detail: "Not Found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    }),
  );
});
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
  root = null;
  vi.unstubAllGlobals();
});
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const col = (over: Partial<DatasetCollection> = {}): DatasetCollection => ({
  id: "kind:image",
  name: "Images",
  kind: "image",
  count: 120,
  unit: { one: "image", other: "images" },
  files: 120,
  formats: [{ label: "PNG", count: 120 }],
  facts: [{ key: "size", label: "Image size", values: [{ value: "512 × 512 px", count: 120 }], more: 0, missing: 0 }],
  fields: [{ id: "fact:size", name: "Image size", type: "text", unit: "px", required: true, filled: 1, source: "inspection" }],
  previewNodeId: null,
  suggested: true,
  issues: 0,
  ...over,
});
const profileOf = (over: Partial<DatasetProfile> = {}): DatasetProfile => ({ datasetId: "d", snapshot: { kind: "draft", label: "Working draft", readOnly: false }, files: 120, checking: 0, collections: [col()], relationships: [], issues: [], ...over });
const dataset: DatasetSummary = { id: "d", projectId: "p", title: "Chest X-rays", description: "", definition: {}, fileCount: 120, tasks: [], createdFromProposalId: null, createdBy: "user:a", createdAt: null };

const query = (over: Partial<ProfileQuery>): ProfileQuery => ({ data: undefined, error: null, isLoading: false, refetch: () => undefined, ...over });
const props = (profile: ProfileQuery, canEdit = true): DatasetViewProps => ({ projectId: "p", dataset, profile, structure: null, canEdit });

const VIEWS: [string, ComponentType<DatasetViewProps>, string][] = [
  ["Overview", DatasetOverview, "overview-empty"],
  ["Structure", DatasetStructure, "structure-empty"],
  ["Fields & Formats", FieldsAndFormats, "fields-empty"],
  ["Quality", DatasetQuality, "quality-clean"],
];

describe.each(VIEWS)("%s states", (_name, View, emptyId) => {
  it("shows a skeleton while loading", async () => {
    await render(h(View, props(query({ isLoading: true }))));
    expect($("[aria-busy]")).not.toBeNull();
    expect(tid("error-view")).toBeNull();
  });

  it("says what failed and offers a retry", async () => {
    const refetch = vi.fn();
    await render(h(View, props(query({ error: new ApiError(500, "boom"), refetch }))));
    const err = tid("error-view")!;
    expect(err.dataset.error).toBe("error");
    await act(async () => [...err.querySelectorAll("button")].find((b) => /Try again/.test(b.textContent ?? ""))!.click());
    expect(refetch).toHaveBeenCalled();
  });

  it("says when the person has no access", async () => {
    await render(h(View, props(query({ error: new ApiError(403, "forbidden") }))));
    expect(tid("error-view")?.dataset.error).toBe("access-denied");
    expect(tid("error-view")?.textContent).toContain("No access");
  });

  it("has an empty state", async () => {
    await render(h(View, props(query({ data: profileOf({ collections: [], files: 0 }) }))));
    expect(tid(emptyId)).not.toBeNull();
  });
});

describe("History states", () => {
  it("without versioning, shows the working draft's activity, empty when nothing happened", async () => {
    routes["/activity"] = json({ entries: [], nextCursor: null });
    await render(h(DatasetHistory, props(query({ data: profileOf() }))));
    expect(tid("history-versioning-off")).not.toBeNull();
    expect(tid("history-empty")).not.toBeNull();
  });

  it("lists changes in words", async () => {
    routes["/activity"] = json({ entries: [{ id: "e1", action: "dataset.created", label: "created the dataset", actor: "user:a", onBehalfOf: null, who: { kind: "person", name: "Ada", onBehalfOf: null }, target: "d", subject: "Chest X-rays", details: {}, at: "2026-11-01T00:00:00Z", link: { section: "datasets", datasetId: "d" } }], nextCursor: null });
    await render(h(DatasetHistory, props(query({ data: profileOf() }))));
    expect($$('[data-testid="history-entry"]').map((e) => e.textContent)).toEqual([expect.stringContaining("Ada created the dataset")]);
  });

  it("says when the history can't be read, or isn't the person's to read", async () => {
    routes["/activity"] = json({ detail: "forbidden" }, 403);
    await render(h(DatasetHistory, props(query({ data: profileOf() }))));
    expect(tid("error-view")?.dataset.error).toBe("access-denied");
  });
});

describe("Annotations states", () => {
  it("has an empty state when no task defines labels", async () => {
    await render(h(AnnotationDefinitions, props(query({ data: profileOf() }))));
    expect(tid("annotations-empty")).not.toBeNull();
  });
});

describe("docs/datasets.md §15", () => {
  it("4: physical format and logical fields are separate sections", async () => {
    await render(h(FieldsAndFormats, props(query({ data: profileOf() }))));
    const format = tid("collection-format")!;
    const fields = tid("collection-fields")!;
    expect(format.textContent).toContain("PNG");
    expect(fields.textContent).toContain("Image size");
    expect(format.contains(fields) || fields.contains(format)).toBe(false);
  });

  it("6: a viewer inspects a collection's fields, formats, constraints and provenance, with no edit actions", async () => {
    await render(h(FieldsAndFormats, props(query({ data: profileOf() }), false)));
    expect(tid("collection-provenance")?.textContent).toContain("120 files this dataset pins");
    const field = $$('[data-testid="field-row"] button')[0];
    await act(async () => field.click());
    expect(tid("field-facts")?.textContent).toMatch(/Optional\s*No/);
    expect(tid("dataset-inspector")?.textContent).toContain("fact:size");
    await render(h(DatasetStructure, props(query({ data: profileOf() }), false)));
    expect(tid("confirm-all-collections")).toBeNull();
  });

  it("a contributor confirms suggested collections: the structure draft is written with them confirmed", async () => {
    routes["/datasets/d/structure"] = json({});
    await render(h(DatasetStructure, props(query({ data: profileOf() }), true)));
    const button = tid("confirm-all-collections")!;
    expect(button.textContent).toContain("Confirm suggested collection");
    await act(async () => button.click());
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    const put = vi.mocked(fetch).mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PUT")!;
    expect(String(put[0])).toContain("/datasets/d/structure");
    const body = JSON.parse(String((put[1] as RequestInit).body));
    expect(body.schemaVersion).toBe(1);
    expect(body.collections).toEqual([expect.objectContaining({ id: "kind:image", suggested: false })]);
  });

  it("17: an unrecognized kind degrades to the generic format reading", async () => {
    await render(h(FieldsAndFormats, props(query({ data: profileOf({ collections: [col({ id: "kind:unknown", kind: "unknown", name: "Files we can't read yet", facts: [], fields: [], formats: [] })] }) }))));
    expect(tid("generic-format")).not.toBeNull();
    expect(tid("collection-format")?.textContent).toContain("File format not known");
  });

  it("18: every selectable structure row is a keyboard control", async () => {
    await render(h(DatasetStructure, props(query({ data: profileOf({ collections: [col(), col({ id: "kind:table", kind: "table", name: "Tables" })] }) }))));
    const rows = $$('[data-testid="structure-collection"]');
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.tagName === "BUTTON" && r.getAttribute("aria-pressed") === "false")).toBe(true);
  });

  it("1: counts name their level, files apart (a series is not its files)", async () => {
    await render(h(DatasetOverview, props(query({ data: profileOf({ collections: [col({ id: "kind:dicom-series", kind: "dicom-series", name: "DICOM series", count: 2, files: 240, unit: { one: "series", other: "series" } })] }) }))));
    expect(tid("collection-count")?.textContent).toBe("2 series · 240 files");
  });
});
