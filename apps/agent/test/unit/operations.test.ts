import { createHash, createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { DEV_APPROVAL_SECRET } from "../../src/config.ts";
import { OPERATIONS, operationRequest, operationToolName } from "@studio/contracts/operations";
import { OPERATION_TOOLS, decideOperation, operationForTool } from "../../src/tools/operations.ts";
import { harness } from "./harness.ts";

/**
 * todo16 Milestone 3 on the scripted model: tools generated from the operations catalogue act
 * with the person's delegated token; deletes go to Trash with Undo; a dataset delete and
 * emptying the Trash ask first (the latter with X-Approval-Id); a viewer's assistant is refused.
 */

const KTOKEN = "kernel-session-token-0123456789";

interface Seen {
  method: string;
  path: string;
  approval: string | null;
  body?: any;
}

function fakeApi(role: "editor" | "viewer" = "editor") {
  const seen: Seen[] = [];
  const trashed = new Set<string>();
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const h = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const p = url.pathname.replace(/^\/api\/v1/, "");
    seen.push({ method, path: p + url.search, approval: h.get("x-approval-id"), body });
    const send = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (h.get("authorization") !== `Bearer ${KTOKEN}`) return send(401, { detail: "bad token" });
    if (p.startsWith("/source-nodes/")) return send(200, { id: p.split("/")[2], kind: "folder", descendantCount: 12 });
    const writes = method !== "GET";
    if (writes && role === "viewer") return send(403, { detail: "You can view this project but not delete from it" });
    if (method === "POST" && p === "/projects/demo/fs/ops") {
      for (const op of body.ops) if (op.kind === "trash") for (const id of op.nodeIds) trashed.add(id);
      return send(200, { batchId: "fsb_1", nodes: [] });
    }
    if (method === "POST" && p === "/projects/demo/fs/undo") {
      trashed.clear();
      return send(200, { undo: null });
    }
    if (method === "DELETE" && p === "/projects/demo/datasets/ds-1") {
      trashed.add("ds-1");
      return send(200, { batchId: "tb_ds", impact: { items: [{ kind: "dataset", id: "ds-1", name: "X" }], files: 0, datasetsLosingItems: [] } });
    }
    if (method === "POST" && p === "/projects/demo/trash/tb_ds/restore") {
      trashed.delete("ds-1");
      return send(200, { restored: [{ kind: "dataset", id: "ds-1" }], relocatedToRoot: false });
    }
    if (method === "POST" && p === "/projects/demo/trash/empty") {
      if (!h.get("x-approval-id")) return send(403, { detail: "Deleting forever needs the person's approval in chat (X-Approval-Id)" });
      return send(200, { purged: 3 });
    }
    return send(200, {});
  }) as typeof fetch;
  return { seen, trashed, fetchImpl };
}

const FIXTURE = {
  scripts: [
    { when: "^delete the pneumonia", turns: [{ toolCalls: [{ name: "source_trash", arguments: { nodeIds: ["nod-pneu"] } }] }, { text: "Moved the pneumonia folder to the Trash. You can undo it." }] },
    { when: "^undo", turns: [{ toolCalls: [{ name: "undo_turn", arguments: {} }] }, { text: "Undone." }] },
    { when: "^delete dataset", turns: [{ toolCalls: [{ name: "dataset_delete", arguments: { datasetId: "ds-1" } }] }, { text: "Dataset X is in the Trash." }] },
    { when: "^bring it back", turns: [{ toolCalls: [{ name: "undo_turn", arguments: {} }] }, { text: "Restored." }] },
    { when: "^empty the trash", turns: [{ toolCalls: [{ name: "trash_empty", arguments: {} }] }, { text: "The Trash is empty; that can't be undone." }] },
  ],
};

let h: Awaited<ReturnType<typeof harness>> | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

async function session(api: ReturnType<typeof fakeApi>) {
  h = await harness(FIXTURE, {}, [], { fetchImpl: api.fetchImpl });
  const s = await h.json("POST", "/v1/sessions", { projectId: "demo", profile: "assistant", clientTools: [], kernelToken: KTOKEN });
  expect(s.status).toBe(201);
  return s.body.sessionId as string;
}

async function say(id: string, text: string, decision?: "approve" | "reject") {
  const r = await h!.json("POST", `/v1/sessions/${id}/messages`, { text });
  expect(r.status).toBe(202);
  const approvals: any[] = [];
  await h!.drive(r.body.runId, async (e: any) => {
    if (e.type === "approval") {
      approvals.push(e);
      await h!.json("POST", `/v1/approvals/${e.approvalId}`, { decision: decision ?? "reject" });
    }
  });
  const msgs = (await h!.sessions.get(id)).piSession.messages as any[];
  const results = msgs.filter((m) => m.role === "toolResult").map((m) => ({ name: m.toolName as string, isError: !!m.isError, text: (m.content as any[]).map((c) => c.text ?? "").join("") }));
  return { approvals, results };
}

describe("operations catalogue", () => {
  it("every operation has an id, tier, route, input and description; tool names are unique", () => {
    const names = new Set<string>();
    for (const o of OPERATIONS) {
      expect(o.id).toMatch(/^[a-z]+\.[a-z_]+$/);
      expect(o.path.startsWith("/")).toBe(true);
      expect(o.description.length).toBeGreaterThan(10);
      expect(names.has(operationToolName(o.id))).toBe(false);
      names.add(operationToolName(o.id));
    }
    for (const id of ["source.trash", "dataset.delete", "studio.delete", "project.delete", "trash.restore", "trash.empty", "trash.destroy"]) expect(OPERATIONS.some((o) => o.id === id)).toBe(true);
    expect(operationRequest(OPERATIONS.find((o) => o.id === "source.rename")!, "p1", { nodeId: "n1", name: "a" })).toEqual({ method: "POST", path: "/projects/p1/fs/ops", body: { ops: [{ kind: "rename", nodeId: "n1", name: "a" }] } });
    expect(operationRequest(OPERATIONS.find((o) => o.id === "dataset.delete")!, "p1", { datasetId: "d 1" }).path).toBe("/projects/p1/datasets/d%201");
    expect(OPERATION_TOOLS.every((o) => o.tier !== "read" || o.id === "trash.list")).toBe(true);
  });

  it("policy by tier: write runs, small trash runs, big trash and datasets ask, destroy always asks", () => {
    const op = (id: string) => operationForTool(operationToolName(id))!;
    expect(decideOperation(op("source.rename"), {}, 100).kind).toBe("allow");
    expect(decideOperation(op("source.trash"), { nodeIds: ["a"] }, 100, { files: 3 }).kind).toBe("allow");
    expect(decideOperation(op("source.trash"), { nodeIds: ["a"] }, 100, { files: 101 })).toMatchObject({ kind: "ask", summary: expect.stringMatching(/101 files/) });
    expect(decideOperation(op("dataset.delete"), { datasetId: "d" }, 100)).toMatchObject({ kind: "ask", detail: { kind: "operation", tier: "trash", irreversible: false } });
    expect(decideOperation(op("trash.empty"), {}, 100)).toMatchObject({ kind: "ask", summary: expect.stringMatching(/can't be undone/), detail: { irreversible: true } });
  });
});

describe("assistant operates the project (scripted model)", () => {
  it('"delete the pneumonia folder" goes to Trash with a batch; "undo these changes" undoes the turn', async () => {
    const api = fakeApi();
    const id = await session(api);
    const a = await say(id, "delete the pneumonia folder");
    expect(a.approvals).toHaveLength(0);
    const r = a.results.find((x) => x.name === "source_trash")!;
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text)).toMatchObject({ movedToTrash: true, batchId: "fsb_1" });
    expect(api.trashed.has("nod-pneu")).toBe(true);
    await say(id, "undo these changes");
    expect(api.seen.some((s) => s.method === "POST" && s.path === "/projects/demo/fs/undo" && s.body.batchId === "fsb_1")).toBe(true);
    expect(api.trashed.size).toBe(0);
  });

  it('"delete dataset X" asks, then trashes; "bring it back" restores the batch', async () => {
    const api = fakeApi();
    const id = await session(api);
    const a = await say(id, "delete dataset X", "approve");
    expect(a.approvals).toHaveLength(1);
    expect(a.approvals[0].detail).toMatchObject({ kind: "operation", opId: "dataset.delete", tier: "trash" });
    expect(api.trashed.has("ds-1")).toBe(true);
    await say(id, "bring it back");
    expect(api.trashed.has("ds-1")).toBe(false);
  });

  it('"empty the trash" asks, says it can\'t be undone, and sends X-Approval-Id', async () => {
    const api = fakeApi();
    const id = await session(api);
    const a = await say(id, "empty the trash", "approve");
    expect(a.approvals[0].summary).toMatch(/can't be undone/);
    const post = api.seen.find((s) => s.path === "/projects/demo/trash/empty")!;
    // todo16 D8: a signed approval bound to the approval, the person's token, the op and project.
    const [v, body, mac] = post.approval!.split(".");
    expect(v).toBe("v1");
    expect(createHmac("sha256", DEV_APPROVAL_SECRET).update(`v1.${body}`).digest("base64url")).toBe(mac);
    const claims = JSON.parse(Buffer.from(body!, "base64url").toString());
    expect(claims).toMatchObject({ aid: a.approvals[0].approvalId, dlg: createHash("sha256").update(KTOKEN).digest("hex"), op: "trash.empty", pid: "demo", tgt: [] });
    const left = claims.exp - Date.now() / 1000;
    expect(left > 0 && left <= 600).toBe(true);
    expect(JSON.parse(a.results.find((x) => x.name === "trash_empty")!.text)).toMatchObject({ deletedForever: true });
  });

  it("declining the approval changes nothing", async () => {
    const api = fakeApi();
    const id = await session(api);
    await say(id, "empty the trash", "reject");
    expect(api.seen.some((s) => s.path === "/projects/demo/trash/empty")).toBe(false);
  });

  it("a viewer's assistant gets refused with the kernel's reason", async () => {
    const api = fakeApi("viewer");
    const id = await session(api);
    const a = await say(id, "delete the pneumonia folder");
    const r = a.results.find((x) => x.name === "source_trash")!;
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/view this project but not delete/);
  });
});

describe("signed approvals (todo16 D8)", () => {
  it("binds targets and signs with the secret", async () => {
    const { approvalToken, operationTargets } = await import("../../src/tools/approval-token.ts");
    expect(operationTargets({ nodeIds: ["a", "b"], name: "x" })).toEqual(["a", "b"]);
    const t = approvalToken({ approvalId: "appr_1", kernelToken: KTOKEN, opId: "source.purge", projectId: "demo", targets: ["a"], secret: "s3cret", now: 1_000_000 });
    const [, body, mac] = t.split(".");
    expect(createHmac("sha256", "s3cret").update(`v1.${body}`).digest("base64url")).toBe(mac);
    expect(JSON.parse(Buffer.from(body!, "base64url").toString())).toEqual({ aid: "appr_1", dlg: createHash("sha256").update(KTOKEN).digest("hex"), op: "source.purge", pid: "demo", tgt: ["a"], exp: 1300 });
  });
});
