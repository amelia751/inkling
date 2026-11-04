import { uploadGate } from "@/studio/app/entry/pending-ask";
import type { TraySession } from "@/studio/stores/uploads";

type GateSession = Pick<TraySession, "phase" | "error" | "stalled" | "files" | "total">;

function kinds(paths: string[]): string {
  const exts = new Map<string, number>();
  for (const p of paths) {
    const m = /\.([a-z0-9]{1,8})$/i.exec(p);
    if (m) exts.set(`.${m[1].toLowerCase()}`, (exts.get(`.${m[1].toLowerCase()}`) ?? 0) + 1);
  }
  return [...exts].map(([e, n]) => `${n} ${e}`).join(", ");
}

/**
 * Files attached in the chat while chat drops are off go through the tray into Sources. The
 * message waits until every one of those uploads stops moving, then says what arrived and what
 * didn't (counts and extensions only, never names).
 */
export function chatUploadsGate(sessions: (GateSession | undefined)[]): { ready: boolean; note: string } {
  const gates = sessions.map(uploadGate);
  if (gates.some((g) => !g.ready)) return { ready: false, note: "" };
  const arrived = sessions.flatMap((s) => s?.files ?? []).filter((f) => f.state === "uploaded" || f.state === "skipped_duplicate").map((f) => f.relPath);
  const k = kinds(arrived);
  const head = arrived.length ? `(Attached ${arrived.length} ${arrived.length === 1 ? "file" : "files"}, now in Sources${k ? `: ${k}` : ""}.)` : "";
  return { ready: true, note: [head, ...gates.map((g) => g.note)].filter(Boolean).join("\n") };
}
