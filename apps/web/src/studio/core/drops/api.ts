import type { CreateDropRequest, Drop } from "@studio/contracts/drops";
import { api } from "@/studio/lib/projects-api";

/**
 * The kernel's drop routes (todo13-drops; `@studio/contracts/drops`). All behind
 * `API_FEATURE_CHAT_DROPS`: a 404 on the project list means the feature is off.
 */
const enc = encodeURIComponent;

export const dropsApi = {
  create: (projectId: string, body: CreateDropRequest) => api<Drop>(`/projects/${enc(projectId)}/drops`, { method: "POST", json: body }),
  get: (dropId: string) => api<Drop>(`/drops/${enc(dropId)}`),
  list: (projectId: string, conversationId?: string) => api<{ drops: Drop[] }>(`/projects/${enc(projectId)}/drops${conversationId ? `?conversationId=${enc(conversationId)}` : ""}`),
  removeFromChat: (dropId: string, nodeId: string) => api<Drop>(`/drops/${enc(dropId)}/files/${enc(nodeId)}`, { method: "DELETE" }),
  conversationDeleted: (projectId: string, conversationId: string) => api<{ drops: number; renamedFolders: string[] }>(`/projects/${enc(projectId)}/conversations/${enc(conversationId)}/deleted`, { method: "POST" }),
};

/** A drop id made in the browser, so the card and the message can name it before the kernel answers. */
export function newDropId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `drp-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
