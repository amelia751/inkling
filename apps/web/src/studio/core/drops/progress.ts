import type { Drop, DropFile, DropFileState } from "@studio/contracts/drops";

/**
 * todo28 D8: a drop is never one thing. The card's headline is built from per-file counts
 * ("12 in the Studio · 22 checking · 1 kept in Sources"), never one "Checking" for the whole
 * drop. The kernel's per-file states gain `in_studio` (the file joined the drop's Studio) and
 * `waiting_kind` (ready, but the Studio doesn't take its kind yet); a file still being checked
 * after a transient error carries `retrying: true`. Older kernels send neither: everything here
 * tolerates their absence.
 */
export type FileState = DropFileState | "in_studio" | "waiting_kind";

/** A file as the kernel sends it once todo28 lands (extra fields optional). */
export type ServerDropFile = Omit<DropFile, "state"> & { state: FileState; retrying?: boolean };

/** The summary's todo28 counts (all optional: an older kernel sends none). */
export interface DropProgressSummary {
  ready?: number;
  inStudio?: number;
  checking?: number;
  failed?: number;
  waitingForKind?: Record<string, number>;
  studioTaskId?: string | null;
}

/** The kernel's drop with the todo28 fields read loosely. */
export type ServerDrop = Omit<Drop, "files" | "summary"> & { files: ServerDropFile[]; summary: Drop["summary"] & DropProgressSummary };

/** A chip's state: the kernel's, or the browser's before the kernel knows the file. */
export type ChipState = FileState | "preparing" | "confirming";

export interface DropCounts {
  confirming: number;
  preparing: number;
  uploading: number;
  inStudio: number;
  ready: number;
  checking: number;
  /** Ready files whose kind the Studio doesn't take yet, by kind. */
  waiting: Record<string, number>;
  kept: number;
  duplicate: number;
  failed: number;
}

/** Count the card's chips; the summary's counts fill in what an older file list can't say. */
export function dropCounts(chips: { state: ChipState; kind?: string | null }[], summary?: DropProgressSummary): DropCounts {
  const c: DropCounts = { confirming: 0, preparing: 0, uploading: 0, inStudio: 0, ready: 0, checking: 0, waiting: {}, kept: 0, duplicate: 0, failed: 0 };
  for (const x of chips) {
    switch (x.state) {
      case "confirming":
        c.confirming++;
        break;
      case "preparing":
        c.preparing++;
        break;
      case "uploading":
        c.uploading++;
        break;
      case "in_studio":
        c.inStudio++;
        break;
      case "ready":
        c.ready++;
        break;
      case "checking":
        c.checking++;
        break;
      case "waiting_kind": {
        const k = x.kind ?? "file";
        c.waiting[k] = (c.waiting[k] ?? 0) + 1;
        break;
      }
      case "kept":
        c.kept++;
        break;
      case "duplicate":
        c.duplicate++;
        break;
      case "failed":
        c.failed++;
        break;
      default:
        break; // removed, deleted: not part of the headline
    }
  }
  // A kernel whose summary knows more than its file states (in the Studio, waiting for a kind):
  // move that many from "ready" so the headline still says where the files are.
  if (summary) {
    const moreInStudio = Math.min(Math.max(0, (summary.inStudio ?? 0) - c.inStudio), c.ready);
    c.inStudio += moreInStudio;
    c.ready -= moreInStudio;
    if (!Object.keys(c.waiting).length && summary.waitingForKind) {
      for (const [k, n] of Object.entries(summary.waitingForKind)) {
        const take = Math.min(n, c.ready);
        if (take > 0) {
          c.waiting[k] = take;
          c.ready -= take;
        }
      }
    }
  }
  return c;
}

const IRREGULAR: Record<string, string> = { audio: "audio files", series: "series", data: "data", media: "media" };

/** "video" → "videos", "dicom-series" → "dicom series": a kind id as a plural noun, domain-neutral. */
export function kindPlural(kind: string): string {
  const words = kind.replace(/[-_.]+/g, " ").trim().toLowerCase() || "file";
  const last = words.split(" ").pop()!;
  if (IRREGULAR[last]) return words.slice(0, words.length - last.length) + IRREGULAR[last];
  if (/s$/.test(last)) return words;
  if (/[^aeiou]y$/.test(last)) return `${words.slice(0, -1)}ies`;
  if (/(x|ch|sh)$/.test(last)) return `${words}es`;
  return `${words}s`;
}

/** What a file waiting for its kind says: "Waiting for the assistant to add videos". */
export function waitingText(kind: string | null | undefined): string {
  return `Waiting for the assistant to add ${kindPlural(kind ?? "file")}`;
}

/** "12 in the Studio · 22 checking · 1 kept in Sources" (empty parts left out). */
export function dropHeadline(c: DropCounts): string {
  if (c.confirming) return "Waiting for you to confirm";
  const parts: string[] = [];
  const add = (n: number, text: string) => n > 0 && parts.push(`${n.toLocaleString()} ${text}`);
  add(c.preparing, "preparing");
  add(c.uploading, "uploading");
  add(c.inStudio, "in the Studio");
  add(c.ready, "ready");
  add(c.checking, "checking");
  for (const [kind, n] of Object.entries(c.waiting)) add(n, `waiting for the assistant to add ${kindPlural(kind)}`);
  add(c.kept, "kept in Sources");
  add(c.duplicate, "already in Sources");
  add(c.failed, "failed");
  return parts.join(" · ") || "Nothing to share";
}
