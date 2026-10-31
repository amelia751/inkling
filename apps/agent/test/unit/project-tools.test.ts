import { describe, expect, it } from "vitest";
import { KernelClient } from "../../src/tools/kernel.ts";
import { type Budgets, type PolicyState, decide } from "../../src/tools/policy.ts";
import { PROJECT_TOOL_NAMES, createProjectTools, shareNode } from "../../src/tools/project.ts";

/**
 * todo6 Phase 6: the project tools read through kernel routes with the session token, never
 * describe privacy-held files, share structure only for restricted projects, create proposals
 * (behind an approval) and report the kernel's 403 when asked to confirm one.
 */

const TOKEN = "kernel-session-token-0123456789";

interface Seen {
  method: string;
  path: string;
  auth: string | null;
  run: string | null;
  body?: unknown;
}

function fakeKernel(restricted = false) {
  const seen: Seen[] = [];
  const nodes: Record<string, any> = {
    "nod-root": { id: "nod-root", name: "upload", kind: "folder", detectedKind: "folder", childCount: 3, descendantCount: 3, size: null, facts: {}, flags: {}, status: "ready" },
    "nod-csv": { id: "nod-csv", name: "diagnosis.csv", kind: "file", detectedKind: "table", childCount: 0, descendantCount: 0, size: 120, facts: { rows: 40, columns: ["patient_id", "label"] }, flags: {}, status: "ready", path: [{ id: "nod-root", name: "upload" }] },
    "nod-held": { id: "nod-held", name: "John_Doe_report.pdf", kind: "file", detectedKind: "document", childCount: 0, descendantCount: 0, size: 9, facts: { pages: 2 }, flags: { privacy: { reason: "name in file name" } }, status: "privacy" },
    "nod-mri": { id: "nod-mri", name: "MRI", kind: "folder", detectedKind: "folder", childCount: 2, descendantCount: 240, size: null, facts: {}, flags: {}, status: "ready", pathText: "MRI", originalPath: "Smith_J_MRI" },
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const h = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ method: init?.method ?? "GET", path: url.pathname + url.search, auth: h.get("authorization"), run: h.get("x-agent-run"), body });
    const send = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (h.get("authorization") !== `Bearer ${TOKEN}`) return send(401, { detail: "invalid or expired session token" });
    const p = url.pathname.replace(/^\/api\/v1/, "");
    if (p === "/projects/prj-1") return send(200, { id: "prj-1", title: "Knee MRI", restricted });
    if (p === "/projects/prj-1/overview")
      return send(200, {
        project: { id: "prj-1", title: "Knee MRI", restricted },
        tasks: [],
        data: [{ type: "source", title: "upload", count: 3, kind: "table", kindLabel: "Tables", nodeId: "nod-root" }],
        attention: [
          { type: "privacy", severity: "high", title: "Held for privacy review", detail: "John_Doe_report.pdf: name in file name", target: { section: "sources", nodeId: "nod-held" } },
          { type: "proposal", severity: "medium", title: "Link diagnosis.csv to MRI", detail: "patient_id ↔ folder", target: { section: "explore", proposalId: "prp-1" } },
        ],
        empty: false,
      });
    if (p === "/projects/prj-1/sources") return send(200, { sources: [{ id: "src-1", title: "upload", kind: "upload", status: "ready", fileCount: 3, rootNodeId: "nod-root", usedInDatasets: [] }] });
    if (p === "/sources/src-1/children") return send(200, { items: [nodes["nod-csv"], nodes["nod-held"], nodes["nod-mri"]], total: 3, nextCursor: null });
    const node = p.match(/^\/source-nodes\/(.+)$/)?.[1];
    if (node) return nodes[node] ? send(200, nodes[node]) : send(404, { detail: "no such node" });
    if (p === "/projects/prj-1/proposals" && init?.method === "POST")
      return send(201, { id: "prp-9", kind: body.kind, status: "proposed", strength: body.strength, createdBy: `agent:${h.get("x-agent-run")}` });
    if (p === "/projects/prj-1/proposals") return send(200, { proposals: [{ id: "prp-1", kind: "relationship", strength: "possible", status: "proposed", payload: {}, evidence: {}, createdBy: "worker:inspect" }] });
    if (p === "/projects/prj-1/imports") return send(200, { imports: [{ id: "imp-1", state: "needs_review", totals: { files: 3, byState: { uploaded: 2, rejected: 1 } } }] });
    if (p === "/projects/prj-1/review")
      return send(200, { items: [{ type: "privacy", title: "Held for privacy review", detail: "John_Doe_report.pdf", target: { section: "sources", nodeId: "nod-held" } }, { type: "import", title: "1 file we can't read yet", detail: "scan.xyz", target: { section: "sources" } }] });
    if (p === "/projects/prj-1/fs") return send(200, { projectId: "prj-1", rootNodeId: "nod-drive", writable: true, trashCount: 0 });
    if (p === "/projects/prj-1/fs/children") {
      const node = url.searchParams.get("node");
      if (!node) return send(200, { items: [{ ...nodes["nod-mri"], parentId: "nod-drive" }, { ...nodes["nod-root"], parentId: "nod-drive", locked: true }], total: 2, nextCursor: null });
      if (node === "nod-mri") return send(200, { items: [{ ...nodes["nod-csv"], parentId: "nod-mri", originalPath: "Smith_J/diagnosis.csv" }, { ...nodes["nod-held"], parentId: "nod-mri" }], total: 2, nextCursor: null });
    }
    if (p === "/projects/prj-1/search") {
      const q = url.searchParams.get("q") ?? "";
      const kind = url.searchParams.get("kind");
      const items = [nodes["nod-csv"], nodes["nod-held"]].filter((n) => n.name.toLowerCase().includes(q.toLowerCase()) && (!kind || n.detectedKind === kind));
      return send(200, { items: items.map((n) => ({ ...n, parentId: "nod-mri", folderPath: "Smith_J_upload" })) });
    }
    if (/^\/proposals\/.+\/confirm$/.test(p)) return send(403, { detail: "only a person can confirm or dismiss a proposal; the assistant can only propose" });
    return send(404, { detail: `no route ${p}` });
  }) as typeof fetch;
  const k = new KernelClient({ baseUrl: "http://kernel.test", workspaceId: "prj-1", token: () => TOKEN, headers: () => ({ "X-Agent-Run": "run_abc" }), fetchImpl });
  const tools = Object.fromEntries(createProjectTools(k).map((t) => [t.name, t]));
  const run = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await tools[name]!.execute(`call_${name}`, args as never, undefined, undefined, undefined as never);
    return { value: JSON.parse((r.content[0] as { text: string }).text), summary: (r.details as { summary: string }).summary };
  };
  return { seen, run, tools };
}

describe("project tools", () => {
  it("list_folder lists the drive by current names: no facts, no original path, held files only marked", async () => {
    const { run } = fakeKernel();
    const top = await run("list_folder");
    expect(top.value.folder).toMatchObject({ id: "nod-drive", root: true });
    expect(top.value.items.map((i: any) => i.id)).toEqual(["nod-mri", "nod-root"]);
    expect(top.value.items[1]).toMatchObject({ locked: true });
    const mri = await run("list_folder", { nodeId: "nod-mri" });
    const text = JSON.stringify(mri.value);
    expect(mri.value.folder).toEqual({ id: "nod-mri", name: "MRI", path: "MRI", kind: "folder" });
    expect(text).toContain("diagnosis.csv");
    expect(text).not.toMatch(/Smith_J|John_Doe|patient_id|rows/);
    expect(mri.value.items[1]).toMatchObject({ id: "nod-held", status: "privacy" });
    await expect(run("list_folder", { nodeId: "nod-csv" })).rejects.toThrow(/is a file/);
  });

  it("find_files searches by name or kind and returns parent ids, never folder paths as uploaded", async () => {
    const { run, seen } = fakeKernel();
    const r = await run("find_files", { kind: "table" });
    expect(r.summary).toBe("1 match");
    expect(r.value.items).toEqual([{ id: "nod-csv", name: "diagnosis.csv", kind: "file", detectedKind: "table", status: "ready", size: 120, parentId: "nod-mri" }]);
    expect(JSON.stringify(r.value)).not.toContain("Smith_J");
    expect(seen.at(-1)?.path).toBe("/api/v1/projects/prj-1/search?q=&kind=table");
    const held = await run("find_files", { query: "john" });
    expect(JSON.stringify(held.value)).not.toContain("John_Doe");
    await expect(run("find_files", {})).rejects.toThrow(/query, a kind/);
  });

  it("restricted projects: find_files by kind only, list_folder without names", async () => {
    const { run } = fakeKernel(true);
    await expect(run("find_files", { query: "diag" })).rejects.toThrow(/restricted/);
    const text = JSON.stringify((await run("list_folder", { nodeId: "nod-mri" })).value);
    expect(text).not.toMatch(/diagnosis|MRI"/);
  });

  it("are the Phase 6 set", () => {
    expect(Object.keys(fakeKernel().tools).sort()).toEqual([...PROJECT_TOOL_NAMES].sort());
  });

  it("list_sources reads through the kernel with the session token and never names held files", async () => {
    const { run, seen } = fakeKernel();
    const { value, summary } = await run("list_sources");
    expect(summary).toBe("1 source · 3 files");
    const text = JSON.stringify(value);
    expect(text).toContain("diagnosis.csv");
    expect(text).not.toContain("John_Doe");
    expect(value.sources[0].top.items.find((i: any) => i.id === "nod-held")).toMatchObject({ status: "privacy", note: expect.stringContaining("not shared") });
    expect(seen.every((s) => s.auth === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("restricted projects share structure only", async () => {
    const { run } = fakeKernel(true);
    const text = JSON.stringify((await run("list_sources")).value);
    expect(text).not.toContain("diagnosis.csv");
    expect(text).not.toContain("patient_id");
    expect(text).toContain('"rows":40');
    const o = JSON.stringify((await run("project_overview")).value);
    expect(o).not.toContain("patient_id");
  });

  it("describe_source_node and the overview withhold privacy-held nodes", async () => {
    const { run } = fakeKernel();
    const held = await run("describe_source_node", { nodeId: "nod-held" });
    expect(JSON.stringify(held.value)).not.toMatch(/John_Doe|pages/);
    expect(held.summary).toBe("Held for privacy review");
    const csv = await run("describe_source_node", { nodeId: "nod-csv" });
    expect(csv.value).toMatchObject({ name: "diagnosis.csv", facts: { rows: 40 }, path: "upload" });
    const o = await run("project_overview");
    expect(JSON.stringify(o.value)).not.toContain("John_Doe");
    expect(o.value.heldFiles).toBe(1);
    const issues = await run("list_import_issues");
    expect(JSON.stringify(issues.value)).not.toContain("John_Doe");
    expect(issues.value.issues).toHaveLength(2);
  });

  it("proposals carry the run (X-Agent-Run) and refuse held nodes", async () => {
    const { run, seen } = fakeKernel();
    const r = await run("propose_relationship", { from: { nodeId: "nod-csv", column: "patient_id" }, to: { nodeId: "nod-mri", key: "folder name" }, rule: "P001 matches patient_001", reason: "40 of 40 ids match" });
    expect(r.value).toMatchObject({ proposal: { id: "prp-9", kind: "relationship", createdBy: "agent:run_abc" }, explore: { section: "explore", proposalId: "prp-9" } });
    expect(seen.find((s) => s.method === "POST")).toMatchObject({ run: "run_abc", body: { kind: "relationship", payload: { rule: "P001 matches patient_001" } } });
    await expect(run("propose_schema", { nodeId: "nod-held", columns: [{ name: "x", type: "text" }], reason: "r" })).rejects.toThrow(/held for privacy review/);
  });

  it("confirm_proposal reports the kernel's 403", async () => {
    const { run } = fakeKernel();
    await expect(run("confirm_proposal", { proposalId: "prp-1" })).rejects.toThrow(/^Refused by the API \(403\): only a person can confirm/);
  });

  it("shareNode drops privacy flags and names for restricted projects", () => {
    const n = { id: "n", name: "a.csv", kind: "file" as const, detectedKind: "table", childCount: 0, descendantCount: 0, size: 1, facts: { header: "Jane" }, flags: { duplicate_of: { nodeId: "m", name: "b.csv" } }, status: "attention" };
    expect(shareNode(n, true)).toEqual({ id: "n", kind: "file", detectedKind: "table", status: "attention", size: 1, facts: {} });
  });
});

describe("project tools policy", () => {
  const s: PolicyState = { toolCalls: 0, startedAt: Date.now(), spendUsd: 0, restricted: false, egressContained: false, userText: "", workspaceId: "prj-1" };
  const b: Budgets = { maxToolCalls: 50, maxRunSeconds: 600, maxSpendUsd: 5 };
  it("asks before creating a proposal and links the card to Explore; reads and confirm attempts are allowed (the kernel decides)", () => {
    expect(decide({ toolName: "propose_relationship", input: { rule: "id ↔ folder" } }, s, b)).toMatchObject({ kind: "ask", detail: { kind: "proposal", proposalKind: "relationship", workspaceId: "prj-1" } });
    expect(decide({ toolName: "propose_schema", input: { columns: [{}, {}] } }, s, b)).toMatchObject({ kind: "ask", summary: expect.stringContaining("2 columns") });
    for (const t of ["list_sources", "project_overview", "describe_source_node", "list_proposals", "list_import_issues", "confirm_proposal", "list_folder", "find_files", "propose_reorganization"]) expect(decide({ toolName: t, input: {} }, s, b).kind).toBe("allow");
  });
});
