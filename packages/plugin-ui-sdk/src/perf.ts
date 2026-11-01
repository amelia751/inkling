import { RES } from "@studio/contracts/naming";

/**
 * Boot timing (todo11 Milestone 1). The shell and renderers leave `performance` marks named
 * `<resourcePrefix>:boot:<step>`; the shell's timeline (apps/web extension-host/boot-timing.ts)
 * reads them back, so there is no shared module state between plugins and the shell.
 */
export const BOOT_MARK_PREFIX = `${RES}:boot:`;

/** Mark a boot step once per boot (the first call wins until the shell starts the next boot). */
export function markBootOnce(step: string, detail?: Record<string, unknown>): void {
  if (typeof performance === "undefined" || typeof performance.mark !== "function") return;
  const name = BOOT_MARK_PREFIX + step;
  if (performance.getEntriesByName(name, "mark").length) return;
  try {
    performance.mark(name, detail ? { detail } : undefined);
  } catch {
    /* marks are best-effort */
  }
}

/**
 * A renderer calls this once its first item is on screen (the first frame a person can look
 * at). Cheap and idempotent: only the first frame of a boot is recorded.
 */
export function markFirstFrame(detail?: { renderer?: string; itemId?: string }): void {
  markBootOnce("first-frame", detail);
}
