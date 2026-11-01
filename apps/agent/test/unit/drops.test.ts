import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "@studio/agent-protocol";
import { dropBlock, safeSummary } from "../../src/tools/drops.ts";
import { harness } from "./harness.ts";

/**
 * todo13-drops (Milestone 1 items 5–6): a message may carry a drop. The service reads the drop's
 * summary from the kernel as the agent (screened names, technical facts), shows it to the model,
 * emits it as a `custom` `drop` event, and stores only that: no bytes, no data or signed URLs,
 * no unscreened name. `get_drop` reads it again later.
 */

const KTOKEN = "kernel-session-token-0123456789";
const DROP = "drp-0123456789abcdef01234567";

/** What a misbehaving kernel might send: the agent must keep only the summary's safe fields. */
const SUMMARY = {
  dropId: DROP,
  origin: "chat",
  state: "inspecting",
  total: 2,
  byKind: { dicom: 1, image: 1 },
  bytes: 1234,
  states: { ready: 2 },
  groups: [{ groupId: "g-dicom", kind: "dicom", count: 1, suggestedAction: "new_dataset" }],
  files: [
    { nodeId: "nod-1", agentName: "dicom-0001.dcm", kind: "dicom", facts: { modality: "CT", rows: 512, patientName: "Smith^John", thumbnail: "data:image/png;base64,iVBORw0KGgo=" } },
    { nodeId: "nod-2", agentName: "chest_01.png", kind: "image", facts: { width: 64, height: 64, format: "https://storage.googleapis.com/b/o?X-Goog-Signature=abc" } },
  ],
  previewUrl: "https://storage.googleapis.com/bucket/obj?X-Goog-Signature=deadbeef",
  bytesB64: "QUJD".repeat(100),
};

function fakeKernel() {
  const seen: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const h = new Headers(init?.headers);
    seen.push(url.pathname + url.search);
    const send = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (h.get("authorization") !== `Bearer ${KTOKEN}`) return send(401, { detail: "invalid token" });
    if (url.pathname === `/api/v1/drops/${DROP}`) return send(200, SUMMARY);
    return send(404, { detail: "no route" });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

const FIXTURE = {
  scripts: [{ turns: [{ toolCalls: [{ name: "get_drop", arguments: { dropId: DROP } }] }, { text: "You dropped a CT slice and a chest X-ray." }] }],
};

function storeText(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(readFileSync(p, "utf8"));
    }
  };
  walk(dir);
  return out.join("\n");
}

let h: Awaited<ReturnType<typeof harness>> | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

describe("drops on messages", () => {
  it("keeps only the summary's safe fields", () => {
    const s = safeSummary(SUMMARY);
    const text = JSON.stringify(s);
    expect(s.files.map((f) => f.agentName)).toEqual(["dicom-0001.dcm", "chest_01.png"]);
    expect(s.files[0]!.facts).toEqual({ modality: "CT", rows: 512 });
    expect(text).not.toMatch(/base64|data:|https?:|Signature|Smith|QUJDQUJD/);
    expect(dropBlock(s, DROP)).toContain(`<drop id="${DROP}">`);
  });

  it("shows the model the summary only, emits the drop part and stores no bytes, links or names", async () => {
    const api = fakeKernel();
    h = await harness(FIXTURE, {}, [], { fetchImpl: api.fetchImpl });
    const s = await h.json("POST", "/v1/sessions", { projectId: "demo", profile: "assistant", clientTools: [], kernelToken: KTOKEN });
    expect(s.status).toBe(201);
    // A drop alone is a message; text alone stays required otherwise.
    expect((await h.json("POST", `/v1/sessions/${s.body.sessionId}/messages`, { text: "" })).status).toBe(400);
    expect((await h.json("POST", `/v1/sessions/${s.body.sessionId}/messages`, { text: "", drop: { dropId: "nope" } })).status).toBe(400);
    const m = await h.json("POST", `/v1/sessions/${s.body.sessionId}/messages`, { text: "", drop: { dropId: DROP }, kernelToken: KTOKEN });
    expect(m.status).toBe(202);
    const events: AgentEvent[] = await h.drive(m.body.runId);
    const part = events.find((e) => e.type === "custom" && e.name === "drop") as Extract<AgentEvent, { type: "custom" }> | undefined;
    expect(part?.value).toEqual({ type: "drop", dropId: DROP, files: [{ nodeId: "nod-1", agentName: "dicom-0001.dcm", kind: "dicom", state: "ready" }, { nodeId: "nod-2", agentName: "chest_01.png", kind: "image", state: "ready" }] });
    expect(events.some((e) => e.type === "tool-result" && e.ok)).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "done", status: "completed" });
    // Read as the agent, twice: once for the message, once by get_drop.
    expect(api.seen.filter((p) => p === `/api/v1/drops/${DROP}`)).toHaveLength(2);
    // The recorded prompt and everything the store keeps.
    await h.sessions.shutdown();
    const stored = storeText(h.dir);
    expect(stored).toContain(`<drop id=\\"${DROP}\\">`);
    expect(stored).toContain("dicom-0001.dcm");
    expect(stored).not.toMatch(/base64|data:image|X-Goog-Signature|https?:\/\/storage|Smith|QUJDQUJD/);
  });

  it("tells the model when the drop can't be read, without failing the message", async () => {
    h = await harness(FIXTURE, {}, [], { fetchImpl: (async () => new Response("{}", { status: 503 })) as typeof fetch });
    const s = await h.json("POST", "/v1/sessions", { projectId: "demo", profile: "assistant", clientTools: [], kernelToken: KTOKEN });
    const m = await h.json("POST", `/v1/sessions/${s.body.sessionId}/messages`, { text: "what did I drop?", drop: { dropId: DROP } });
    expect(m.status).toBe(202);
    const events: AgentEvent[] = await h.drive(m.body.runId);
    expect(events.some((e) => e.type === "custom")).toBe(false);
  });
});
