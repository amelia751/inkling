import type { ChangeProvenance } from "@/studio/lib/api";
import { useAgent } from "@/studio/stores/agent";

/** `sha256:<hex>` of a prompt's UTF-8 text: what a revision records instead of the prompt itself. */
export async function promptHash(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `sha256:${[...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The provenance of a change the assistant is making right now (todo10 Phase 1): the active
 * run's id and the hash of the person's message that started it. The kernel stores both on the
 * environment revision; the prompt text never leaves the thread.
 */
export async function activeRunProvenance(projectId: string): Promise<ChangeProvenance> {
  const s = useAgent.getState();
  const a = s.active?.projectId === projectId ? s.active : null;
  if (!a) return { kind: "agent" };
  const thread = s.threads[projectId] ?? [];
  const at = thread.findIndex((m) => m.id === a.messageId);
  const user = thread.slice(0, at < 0 ? thread.length : at).reverse().find((m) => m.role === "user");
  const text = user?.parts.map((p) => (p.type === "text" ? p.text : "")).join("") ?? "";
  return { kind: "agent", runId: a.runId, ...(text ? { promptHash: await promptHash(text) } : {}) };
}
