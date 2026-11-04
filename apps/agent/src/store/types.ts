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

export type SessionScope = "project" | "home";

/** Session meta as stored: opaque JSON apart from the fields the store indexes. */
export interface StoredMeta {
  id: string;
  owner: string;
  /** null for a Home chat (todo21 D8). */
  projectId: string | null;
  /** todo21 D8: `home` chats route between projects; unset (stored before todo21) is `project`. */
  scope?: SessionScope;
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
  /** todo27 W1: the run's OpenTelemetry trace id, when the agent was exporting traces. */
  traceId?: string;
}

export type RunPatch = { status?: StoredRunStatus; usage?: RunUsage; toolCalls?: number; traceId?: string };

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

/**
 * todo22 W4: a thread part that isn't in the pi transcript (a card, a boot or an environment change
 * the browser added, an approval the service asked for), recorded so the thread replays the same on
 * any device. One row per `partKey` (`<type>:<id>`); a later write replaces the part (card applied).
 */
export interface UiPartRecord {
  sessionId: string;
  /** The run whose assistant message holds the part (placement on replay); null for a local turn. */
  runId: string | null;
  /** The browser's message id (placement when there's no run). */
  messageId: string;
  partKey: string;
  part: { type: string; id: string; [key: string]: unknown };
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
  /** Sessions of one owner in one organization (`orgId` unset: sessions without one), optionally one project or one scope. */
  listSessions(filter: { owner: string; orgId: string | undefined; projectId?: string; scope?: SessionScope }): Promise<StoredMeta[]>;
  countSessions(): Promise<number>;
  /**
   * Sessions in one organization, or only `owner`'s there (todo14 D9: deleting an org, removing a
   * member). Served by the `(org_id, owner)` index; never scans other organizations.
   */
  listOrgSessions(filter: { orgId: string; owner?: string }): Promise<StoredMeta[]>;
  /** Every run id (any status) of these sessions, so their run-event streams can be dropped too. */
  runIdsForSessions(sessionIds: string[]): Promise<string[]>;
  /** Meta, transcript, runs and inputs. */
  deleteSession(id: string): Promise<void>;
  /** Bumped by every putMeta/appendTranscript; lets a replica notice its cached session is stale. */
  revision(id: string): Promise<number | undefined>;
  /** Header first, then entries, as JSON values. */
  readTranscript(id: string): Promise<unknown[]>;
  /** Write `items` at positions `from`, `from + 1`, … (position 0 is the header). Idempotent per position. */
  appendTranscript(id: string, from: number, items: unknown[]): Promise<number | undefined>;
  /**
   * todo21 W4: a new session `meta` holding the source's transcript rows `1..uptoIdx - 1` under
   * `header` (row 0), in one transaction. The caller checks ownership and maps the message index.
   */
  branchSession(sourceId: string, uptoIdx: number, meta: StoredMeta, header: unknown): Promise<void>;

  /** todo22 W4: insert or replace one recorded thread part. */
  putUiPart(rec: UiPartRecord): Promise<void>;
  /** todo22 W4: a session's recorded thread parts, in the order they were first recorded. */
  listUiParts(sessionId: string): Promise<UiPartRecord[]>;

  // ---- runs ----
  /** False when the session already has an active run (one active run per session, cluster-wide). */
  insertRun(rec: RunRecord): Promise<boolean>;
  updateRun(id: string, patch: RunPatch): Promise<void>;
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
