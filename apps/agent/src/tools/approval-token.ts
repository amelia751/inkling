import { createHash, createHmac } from "node:crypto";

/**
 * Signed destroy approvals (todo16 D8). After the person approves a destroy in chat, the tool
 * sends `X-Approval-Id: v1.<claims>.<HMAC-SHA256>` instead of the bare approval id; the api
 * (`studio_api.kernel.approvals.verify`) checks the signature, that the delegated token it
 * arrives with is the one it was issued for (`dlg`), the operation, project, targets, expiry
 * (at most ten minutes) and that it is used once.
 */
export interface ApprovalClaims {
  /** The broker's approval id. */
  aid: string;
  /** sha256 (hex) of the person's delegated kernel token: binds the approval to that person. */
  dlg: string;
  /** Operation id from the catalogue (`source.purge`, `trash.destroy`, `trash.empty`). */
  op: string;
  pid: string;
  /** The ids the operation touches (node ids, batch id); empty for Empty Trash. */
  tgt: string[];
  /** Unix seconds. */
  exp: number;
}

export const APPROVAL_TTL_S = 300;

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function signApproval(claims: ApprovalClaims, secret: string): string {
  const body = b64(JSON.stringify(claims));
  const mac = createHmac("sha256", secret).update(`v1.${body}`).digest();
  return `v1.${body}.${b64(mac)}`;
}

export function approvalToken(a: { approvalId: string; kernelToken: string; opId: string; projectId: string; targets: string[]; secret: string; now?: number }): string {
  const exp = Math.floor((a.now ?? Date.now()) / 1000) + APPROVAL_TTL_S;
  const dlg = createHash("sha256").update(a.kernelToken).digest("hex");
  return signApproval({ aid: a.approvalId, dlg, op: a.opId, pid: a.projectId, tgt: a.targets, exp }, a.secret);
}

/** The ids a catalogue call names (the same ones the approval card lists). */
export function operationTargets(input: Record<string, unknown>): string[] {
  return Object.entries(input)
    .filter(([k]) => k.endsWith("Id") || k === "nodeIds")
    .flatMap(([, v]) => (Array.isArray(v) ? v : [v]))
    .filter((v) => v !== undefined && v !== null)
    .map(String);
}
