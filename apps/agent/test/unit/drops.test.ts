import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "@studio/agent-protocol";
import { dropBlock, dropStatus, safeSummary, waitForDrop } from "../../src/tools/drops.ts";
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
  // Settled, so get_drop answers at once (todo20 D8: it waits for a drop still in progress).
  state: "ready",
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

describe("waiting for a drop to settle (todo20 D8)", () => {
  const kernelSeq = (states: Record<string, unknown>[]) => {
    let i = 0;
    const calls = { n: 0 };
    const k = { get: async () => { calls.n += 1; return states[Math.min(i++, states.length - 1)]; } } as unknown as Parameters<typeof waitForDrop>[0];
    return { k, calls };
  };
  const base = { dropId: DROP, byKind: {}, bytes: 0, groups: [], files: [] };

  it("polls until the drop settles and never says 0 files mid-upload", async () => {
    const { k, calls } = kernelSeq([
      { ...base, state: "uploading", total: 0, expected: 35, states: {} },
      { ...base, state: "uploading", total: 35, expected: 35, states: { uploading: 23 } },
      { ...base, state: "duplicate", total: 35, expected: 35, states: { duplicate: 35 } },
    ]);
    let t = 0;
    const { summary, settled } = await waitForDrop(k, DROP, { sleep: async (ms) => void (t += ms), now: () => t });
    expect(settled).toBe(true);
    expect(calls.n).toBe(3);
    expect(summary.status).toBe("These 35 files are already in this project");
  });

  it("gives up after the bound and says how far the upload got", async () => {
    const { k } = kernelSeq([{ ...base, state: "uploading", total: 35, expected: 35, states: { uploading: 23 } }]);
    let t = 0;
    const { summary, settled } = await waitForDrop(k, DROP, { timeoutMs: 20_000, sleep: async (ms) => void (t += ms), now: () => t });
    expect(settled).toBe(false);
    expect(t).toBeLessThanOrEqual(20_000);
    expect(summary.status).toBe("Still uploading (12 of 35)");
    expect(dropStatus({ ...base, state: "uploading", total: 0, states: {} } as never)).toBe("Still uploading: no file has arrived yet");
  });

  it("reports a failed drop with its reason and grouped findings, and a partly ready one", () => {
    const failed = safeSummary({ ...base, state: "failed", total: 0, states: {}, failure: { step: "import", reason: "The write breaks the project's rules" }, findings: [{ rule: "name.pattern", outcome: "refused", count: 35, files: ["Smith.dcm"] }] });
    expect(JSON.stringify(failed)).not.toContain("Smith");
    expect(dropStatus(failed)).toBe("The drop failed: The write breaks the project's rules (35 files: name.pattern (refused))");
    expect(dropStatus({ ...base, state: "partly_ready", total: 35, states: { ready: 33, failed: 2 } } as never)).toBe("33 files ready, 2 failed");
  });
});
