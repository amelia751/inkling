import { randomUUID } from "node:crypto";
import type { ApprovalDetail } from "@studio/agent-protocol";

export interface ApprovalRequest {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  summary: string;
  inputPreview: string;
  /** Structured context the Studio renders (e.g. the install review for plugin-install). */
  detail?: ApprovalDetail;
}

export interface ApprovalDecision {
  decision: "approve" | "reject";
  note?: string;
  /** The request's id, set on the decision `request` resolves with (destroy operations send it as `X-Approval-Id`). */
  approvalId?: string;
}

/** Pending approvals with expiry; an expired or cancelled approval counts as a rejection. */
export class ApprovalBroker {
  private readonly pending = new Map<string, { resolve: (d: ApprovalDecision) => void; timer: NodeJS.Timeout }>();

  constructor(
    private readonly opts: {
      expiresS: number;
      emit: (req: ApprovalRequest) => void;
      /** Every request ends here exactly once: decided, expired or cancelled. */
      onResolved?: (approvalId: string, d: ApprovalDecision) => void;
    },
  ) {}

  request(req: Omit<ApprovalRequest, "approvalId">, signal?: AbortSignal): Promise<ApprovalDecision> {
    const approvalId = `apr_${randomUUID()}`;
    return new Promise((resolve) => {
      const finish = (d: ApprovalDecision) => {
        clearTimeout(timer);
        this.pending.delete(approvalId);
        signal?.removeEventListener("abort", onAbort);
        this.opts.onResolved?.(approvalId, d);
        resolve({ ...d, approvalId });
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
