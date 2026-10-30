import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type InputKind, type InputRecord, type RunRecord, type RunUsage, type SessionStore, type StoredMeta, type StoredRunStatus, isActiveStatus } from "./types.ts";

const SESSION_ID = /^ses_[0-9a-f-]{36}$/;
const RUN_ID = /^run_[0-9a-f-]{36}$/;

/**
 * Dev store: one process, files under the data dir exactly as before (`sessions/<id>.meta.json`,
 * `sessions/<id>.jsonl`) plus `runs/<id>.json`. Run inputs are in memory (they only matter while
 * the loop that waits for them is alive, and there's only one process).
 */
export class FileSessionStore implements SessionStore {
  readonly kind = "file" as const;
  private readonly runs = new Map<string, RunRecord>();
  private readonly inputs = new Map<string, InputRecord>();

  constructor(
    readonly dir: string,
    readonly runsDir: string,
  ) {
    mkdirSync(dir, { recursive: true });
    mkdirSync(runsDir, { recursive: true });
  }

  /** One process owns everything: runs left active by a previous process were interrupted. */
  async init(): Promise<void> {
    for (const f of readdirSync(this.runsDir).filter((n) => n.endsWith(".json"))) {
      const rec = this.readRun(f.slice(0, -5));
      if (rec && isActiveStatus(rec.status)) this.writeRun({ ...rec, status: "interrupted", updatedAt: Date.now() });
    }
  }

  async ping(): Promise<void> {
    if (!existsSync(this.dir)) throw new Error("data dir missing");
  }

  async close(): Promise<void> {}

  // ---- sessions ----

  private metaPath = (id: string) => join(this.dir, `${id}.meta.json`);
  private jsonlPath = (id: string) => join(this.dir, `${id}.jsonl`);
  private runPath = (id: string) => join(this.runsDir, `${id}.json`);

  async getMeta(id: string): Promise<StoredMeta | undefined> {
    if (!SESSION_ID.test(id)) return undefined;
    try {
      return JSON.parse(readFileSync(this.metaPath(id), "utf8")) as StoredMeta;
    } catch {
      return undefined;
    }
  }

  async putMeta(meta: StoredMeta): Promise<undefined> {
    writeFileSync(this.metaPath(meta.id), JSON.stringify(meta, null, 2));
    return undefined;
  }

  async listSessionIds(): Promise<Set<string>> {
    if (!existsSync(this.dir)) return new Set();
    return new Set(
      readdirSync(this.dir)
        .filter((f) => f.endsWith(".meta.json"))
        .map((f) => f.slice(0, -".meta.json".length)),
    );
  }

  async countSessions(): Promise<number> {
    return (await this.listSessionIds()).size;
  }

  async deleteSession(id: string): Promise<void> {
    if (!SESSION_ID.test(id)) return;
    rmSync(this.metaPath(id), { force: true });
    rmSync(this.jsonlPath(id), { force: true });
    for (const [runId, r] of this.runs)
      if (r.sessionId === id) {
        this.runs.delete(runId);
        rmSync(this.runPath(runId), { force: true });
      }
    for (const [k, i] of this.inputs) if (i.sessionId === id) this.inputs.delete(k);
  }

  async revision(): Promise<undefined> {
    return undefined;
  }

  async readTranscript(id: string): Promise<unknown[]> {
    if (!SESSION_ID.test(id) || !existsSync(this.jsonlPath(id))) return [];
    return readFileSync(this.jsonlPath(id), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as unknown);
  }

  async appendTranscript(id: string, from: number, items: unknown[]): Promise<undefined> {
    if (!items.length) return undefined;
    const text = items.map((e) => `${JSON.stringify(e)}\n`).join("");
    if (from === 0) writeFileSync(this.jsonlPath(id), text);
    else appendFileSync(this.jsonlPath(id), text);
    return undefined;
  }

  // ---- runs ----

  private readRun(id: string): RunRecord | undefined {
    const cached = this.runs.get(id);
    if (cached) return cached;
    if (!RUN_ID.test(id)) return undefined;
    try {
      const rec = JSON.parse(readFileSync(this.runPath(id), "utf8")) as RunRecord;
      this.runs.set(id, rec);
      return rec;
    } catch {
      return undefined;
    }
  }

  private writeRun(rec: RunRecord): void {
    this.runs.set(rec.id, rec);
    writeFileSync(this.runPath(rec.id), JSON.stringify(rec));
  }

  async insertRun(rec: RunRecord): Promise<boolean> {
    if (await this.activeRunForSession(rec.sessionId)) return false;
    this.writeRun(rec);
    return true;
  }

  async updateRun(id: string, patch: { status?: StoredRunStatus; usage?: RunUsage; toolCalls?: number }): Promise<void> {
    const rec = this.readRun(id);
    if (!rec) return;
    // Terminal states are final, as in the Postgres store.
    if (patch.status && !isActiveStatus(rec.status) && patch.status !== rec.status) delete patch.status;
    this.writeRun({ ...rec, ...patch, updatedAt: Date.now() });
  }

  async getRun(id: string): Promise<RunRecord | undefined> {
    return this.readRun(id);
  }

  async activeRunForSession(sessionId: string): Promise<RunRecord | undefined> {
    return [...this.runs.values()].find((r) => r.sessionId === sessionId && isActiveStatus(r.status));
  }

  async activeSessionIds(): Promise<Set<string>> {
    return new Set([...this.runs.values()].filter((r) => isActiveStatus(r.status)).map((r) => r.sessionId));
  }

  async heartbeat(ids: string[], replica: string): Promise<string[]> {
    const lost: string[] = [];
    const now = Date.now();
    for (const id of ids) {
      const r = this.runs.get(id);
      if (r && r.replica === replica && isActiveStatus(r.status)) r.heartbeatAt = now;
      else lost.push(id);
    }
    return lost;
  }

  async interruptIfStale(id: string, leaseMs: number): Promise<boolean> {
    const r = this.readRun(id);
    if (!r || !isActiveStatus(r.status) || r.heartbeatAt >= Date.now() - leaseMs) return false;
    await this.markInterrupted(id);
    return true;
  }

  async markInterrupted(id: string): Promise<void> {
    const r = this.readRun(id);
    if (!r || !isActiveStatus(r.status)) return;
    this.writeRun({ ...r, status: "interrupted", updatedAt: Date.now() });
    await this.closeRunInputs(id);
  }

  // ---- inputs ----

  openInput(rec: Omit<InputRecord, "state" | "createdAt">): void {
    this.inputs.set(rec.id, { ...rec, state: "pending", createdAt: Date.now() });
  }

  async answerInput(id: string, kind: InputKind, owner: string, payload: unknown): Promise<InputRecord | undefined> {
    const i = this.inputs.get(id);
    if (!i || i.kind !== kind || i.owner !== owner || i.state !== "pending") return undefined;
    const run = this.readRun(i.runId);
    if (run && !isActiveStatus(run.status)) return undefined;
    i.state = "answered";
    i.payload = payload;
    return { ...i };
  }

  async pushCommand(rec: Omit<InputRecord, "state" | "createdAt">): Promise<void> {
    this.inputs.set(rec.id, { ...rec, state: "answered", createdAt: Date.now() });
  }

  async takeAnswered(runIds: string[]): Promise<InputRecord[]> {
    const want = new Set(runIds);
    const out: InputRecord[] = [];
    for (const i of this.inputs.values())
      if (want.has(i.runId) && i.state === "answered") {
        i.state = "closed";
        out.push({ ...i });
      }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  async closeInput(id: string): Promise<void> {
    const i = this.inputs.get(id);
    if (i) this.inputs.delete(id);
  }

  async closeRunInputs(runId: string): Promise<void> {
    for (const [k, i] of this.inputs) if (i.runId === runId) this.inputs.delete(k);
  }
}
