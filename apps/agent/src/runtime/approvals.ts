import { randomUUID } from "node:crypto";

export interface ApprovalRequest {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  summary: string;
  inputPreview: string;
}

export interface ApprovalDecision {
  decision: "approve" | "reject";
  note?: string;
}

/** Pending approvals with expiry; an expired or cancelled approval counts as a rejection. */
export class ApprovalBroker {
  private readonly pending = new Map<string, { resolve: (d: ApprovalDecision) => void; timer: NodeJS.Timeout }>();

  constructor(private readonly opts: { expiresS: number; emit: (req: ApprovalRequest) => void }) {}

  request(req: Omit<ApprovalRequest, "approvalId">, signal?: AbortSignal): Promise<ApprovalDecision> {
    const approvalId = `apr_${randomUUID()}`;
    return new Promise((resolve) => {
      const finish = (d: ApprovalDecision) => {
        clearTimeout(timer);
        this.pending.delete(approvalId);
        signal?.removeEventListener("abort", onAbort);
        resolve(d);
      };
      const onAbort = () => finish({ decision: "reject", note: "run cancelled" });
      const timer = setTimeout(() => finish({ decision: "reject", note: "approval expired" }), this.opts.expiresS * 1000);
      this.pending.set(approvalId, { resolve: finish, timer });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.opts.emit({ approvalId, ...req });
    });
  }

  decide(approvalId: string, d: ApprovalDecision): boolean {
    const p = this.pending.get(approvalId);
    if (!p) return false;
    p.resolve(d);
    return true;
  }

  has(approvalId: string): boolean {
    return this.pending.has(approvalId);
  }

  rejectAll(note: string): void {
    for (const p of [...this.pending.values()]) p.resolve({ decision: "reject", note });
  }

  get size(): number {
    return this.pending.size;
  }
}
