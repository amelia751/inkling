/**
 * Drops (todo13 §5, workstream todo13-drops): one gesture of files dropped, pasted or attached in
 * a chat, on Home, in Files or on a Studio canvas. The kernel's table `drops` groups the import
 * sessions of the gesture (`import_sessions.drop_id`); chat drops land in
 * `Shared in chat/<conversation>`. `DropPlan` (the classifier's plan) lives with the classifier.
 *
 * Routes (behind `API_FEATURE_CHAT_DROPS`; 404 when off):
 *   POST   /api/v1/projects/:id/drops                         → Drop (a person; viewers 403; 413 over the limits; 429 over the rate)
 *   GET    /api/v1/projects/:id/drops?conversationId=         → { drops: Drop[] }   (Shared files)
 *   GET    /api/v1/drops/:id?offset=                          → Drop (person) | DropSummary (agent: screened names)
 *   DELETE /api/v1/drops/:id/files/:nodeId                    → Drop                (remove from the chat; the File stays)
 *   POST   /api/v1/projects/:id/conversations/:cid/deleted    → { drops, renamedFolders }
 * Uploads: `POST /api/v1/projects/:id/imports` with `origin: DropOrigin & { dropId }`.
 */

export type DropOriginKind = "chat" | "files" | "studio" | "home";

export type DropState = "uploading" | "inspecting" | "classified" | "planned" | "applied" | "failed";

/** The `origin` of an import that belongs to a drop. */
export interface DropOrigin {
  kind: DropOriginKind;
  conversationId?: string;
  messageId?: string;
  /** Names the `Shared in chat` subfolder the first time a conversation shares files. */
  conversationTitle?: string;
  dropId?: string;
}

/** What `POST /projects/:id/drops` takes. `id` (`drp-…`) makes a retry return the same drop. */
export interface CreateDropRequest {
  origin: DropOriginKind;
  id?: string;
  conversationId?: string;
  conversationTitle?: string;
  messageId?: string;
  taskId?: string;
  datasetId?: string;
  /** Declared before hashing, for the limits and the card. */
  files?: number;
  bytes?: number;
}

/**
 * A file's state on the drop card: `uploading`, `checking` (inspection), `ready` (usable in a
 * Studio), `kept` (stays in Files: documents, tables, unknown kinds), `failed`, `duplicate`
 * ("Already in Files"), `removed` (taken out of the chat), `deleted` (the File is gone).
 */
export type DropFileState = "uploading" | "checking" | "ready" | "kept" | "failed" | "duplicate" | "removed" | "deleted";

/** A file of a drop as a person sees it (names included: never sent to the agent). */
export interface DropFile {
  clientFileId: string;
  importId: string;
  nodeId: string | null;
  name: string;
  relPath: string;
  size: number;
  received: number;
  sha256: string;
  uploadState: "pending" | "uploaded" | "skipped_duplicate" | "rejected" | "failed";
  state: DropFileState;
  reason: string | null;
  kind: string | null;
  /** The extension says one kind, the bytes another (D14): "ZIP", "an image"… */
  looksLike: string | null;
  flags: string[];
}

export interface Drop {
  id: string;
  projectId: string;
  origin: DropOriginKind;
  conversationId: string | null;
  messageId: string | null;
  taskId: string | null;
  datasetId: string | null;
  /** `Shared in chat/<conversation>` for a chat drop. */
  folderNodeId: string | null;
  state: DropState;
  declared: { files?: number; bytes?: number; conversationTitle?: string; conversationDeleted?: boolean };
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  importIds: string[];
  files: DropFile[];
  summary: DropSummary;
}

/** A group as the agent's summary shows it (the classifier's full group is `DropGroup` in `drop-plan.ts`). */
export interface DropSummaryGroup {
  groupId: string;
  kind: string;
  count: number;
  /** Most common shape, e.g. "512x512". */
  shape?: string;
  suggestedAction: string;
}

/**
 * What the agent sees of a drop (D3): counts, groups, and per file its node id, its screened name
 * and technical facts (dimensions, frames, duration, modality, column names and types, pages).
 * Never pixels, text content, cell values, raw DICOM headers or an unscreened name. The first
 * 50 files; `nextOffset` pages the rest (`GET /drops/:id?offset=`).
 */
export interface DropSummary {
  dropId: string;
  origin: DropOriginKind;
  state: DropState;
  total: number;
  byKind: Record<string, number>;
  bytes: number;
  states: Partial<Record<DropFileState, number>>;
  groups: DropSummaryGroup[];
  files: { nodeId: string; agentName: string; kind?: string; facts?: Record<string, unknown> }[];
  nextOffset?: number;
}

/** In `SourceNodeDetail.provenance.drop`: "Shared in chat · <conversation> · <date>". */
export interface DropProvenance {
  dropId: string;
  origin: DropOriginKind;
  conversationId: string | null;
  conversationTitle: string | null;
  conversationDeleted: boolean;
  sharedAt: string | null;
  removedFromChat: boolean;
}

/** Project-stream events (kernel outbox envelope). */
export interface DropReceivedEvent {
  projectId: string;
  dropId: string;
  origin: DropOriginKind;
  count: number;
}
export interface DropFileEvent {
  projectId: string;
  dropId: string;
  nodeId: string;
  state: DropFileState;
}
// drop.classified, drop.planned and drop.applied payloads: `drop-plan.ts` (todo13-organize).
export interface DropFailedEvent {
  projectId: string;
  dropId: string;
  step: string;
  errorClass: string;
}

export const DROP_EVENTS = ["drop.received", "drop.file", "drop.classified", "drop.planned", "drop.applied", "drop.failed"] as const;
export type DropEventType = (typeof DROP_EVENTS)[number];

/** The `drop` part of a chat message (agent protocol): ids and screened names only. */
export interface DropMessagePart {
  type: "drop";
  dropId: string;
  files: { nodeId: string; agentName: string; kind?: string; state: DropFileState }[];
}
