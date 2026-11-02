import type { RunStatus } from "@studio/agent-protocol";

/**
 * Durable state of the agent service, behind one interface so any replica can serve any request
 * (todo/done/todo3.md E.1). `file` (dev, one process) keeps today's `.data/` layout; `postgres` is for
 * everything with more than one replica.
 *
 * What lives here: session meta, the pi transcript (JSONL entries, header first), run records (status,
 * owning replica, heartbeat) and run inputs (pending approvals, client-tool calls, and steer/cancel
 * commands addressed to the replica that runs the loop).
 */

/** Session meta as stored: opaque JSON apart from the fields the store indexes. */
export interface StoredMeta {
  id: string;
  owner: string;
  projectId: string;
  /** WorkOS organization of the owner when the session was created (todo9 Phase 5); unset in dev mode. */
  orgId?: string;
  [key: string]: unknown;
}

/** `interrupted`: the replica running the loop stopped (crash or shutdown); the user can resume. */
export type StoredRunStatus = RunStatus | "interrupted";

export const ACTIVE_STATUSES: readonly StoredRunStatus[] = ["queued", "running", "awaiting_approval"];
export const isActiveStatus = (s: StoredRunStatus) => ACTIVE_STATUSES.includes(s);

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
}

export interface RunRecord {
  id: string;
  sessionId: string;
  owner: string;
  status: StoredRunStatus;
  /** Replica whose process runs the loop. */
  replica: string;
  createdAt: number;
  updatedAt: number;
  heartbeatAt: number;
  usage?: RunUsage;
  toolCalls?: number;
}

export type InputKind = "approval" | "client-tool" | "steer" | "cancel";

/**
 * `pending`: waiting for the user (approval, client tool). `answered`: the answer (or a steer/cancel
 * command) is stored but the loop hasn't taken it yet. `closed`: taken, expired or cancelled.
 */
export type InputState = "pending" | "answered" | "closed";

export interface InputRecord {
  /** approvalId, `<runId>:<callId>` for client tools, `cmd_<uuid>` for commands. */
  id: string;
  runId: string;
  sessionId: string;
  owner: string;
  kind: InputKind;
  state: InputState;
  payload?: unknown;
  createdAt: number;
}

export interface SessionStore {
  readonly kind: "file" | "postgres";
  /** Create directories / check (or, with auto-migrate, apply) the schema. */
  init(): Promise<void>;
  /** Readiness: throws when the backend is unreachable. */
  ping(): Promise<void>;
  close(): Promise<void>;

  // ---- sessions ----
  getMeta(id: string): Promise<StoredMeta | undefined>;
  /** Insert or replace. Returns the session's new revision (undefined when not tracked). */
  putMeta(meta: StoredMeta): Promise<number | undefined>;
  listSessionIds(): Promise<Set<string>>;
  /** Sessions of one owner in one organization (`orgId` unset: sessions without one), optionally one project. */
  listSessions(filter: { owner: string; orgId: string | undefined; projectId?: string }): Promise<StoredMeta[]>;
  countSessions(): Promise<number>;
  /** Meta, transcript, runs and inputs. */
  deleteSession(id: string): Promise<void>;
  /** Bumped by every putMeta/appendTranscript; lets a replica notice its cached session is stale. */
  revision(id: string): Promise<number | undefined>;
  /** Header first, then entries, as JSON values. */
  readTranscript(id: string): Promise<unknown[]>;
  /** Write `items` at positions `from`, `from + 1`, … (position 0 is the header). Idempotent per position. */
  appendTranscript(id: string, from: number, items: unknown[]): Promise<number | undefined>;

  // ---- runs ----
  /** False when the session already has an active run (one active run per session, cluster-wide). */
  insertRun(rec: RunRecord): Promise<boolean>;
  updateRun(id: string, patch: { status?: StoredRunStatus; usage?: RunUsage; toolCalls?: number }): Promise<void>;
  getRun(id: string): Promise<RunRecord | undefined>;
  activeRunForSession(sessionId: string): Promise<RunRecord | undefined>;
  /** Sessions with an active run anywhere (the sweeper must not touch their sandboxes). */
  activeSessionIds(): Promise<Set<string>>;
  /** Refresh the lease of runs `replica` still owns; returns the ids it no longer owns or that ended. */
  heartbeat(ids: string[], replica: string): Promise<string[]>;
  /** Mark an active run interrupted when its last heartbeat is older than `leaseMs`. True if this call did it. */
  interruptIfStale(id: string, leaseMs: number): Promise<boolean>;
  /** Mark an active run interrupted unconditionally (graceful shutdown of the owning replica). */
  markInterrupted(id: string): Promise<void>;

  // ---- run inputs ----
  /** Record a pending approval/client-tool call. Sync for the file store so events keep their order. */
  openInput(rec: Omit<InputRecord, "state" | "createdAt">): void | Promise<void>;
  /** pending → answered, only for the owner and while the run is active. The record, or undefined. */
  answerInput(id: string, kind: InputKind, owner: string, payload: unknown): Promise<InputRecord | undefined>;
  /** A command for the loop's replica (steer, cancel): stored as answered. */
  pushCommand(rec: Omit<InputRecord, "state" | "createdAt">): Promise<void>;
  /** answered → closed for these runs, returning what was taken (each answer is delivered once). */
  takeAnswered(runIds: string[]): Promise<InputRecord[]>;
  closeInput(id: string): Promise<void>;
  closeRunInputs(runId: string): Promise<void>;
}
