import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { ApprovalBroker } from "../runtime/approvals.ts";

export type Decision = { kind: "allow" } | { kind: "deny"; reason: string } | { kind: "ask"; summary: string };

export interface Budgets {
  maxToolCalls: number;
  maxRunSeconds: number;
  maxSpendUsd: number;
}

export interface PolicyState {
  toolCalls: number;
  startedAt: number;
  spendUsd: number;
  restricted: boolean;
  /** Org tier allows an egress allowlist, so installs from allowlisted hosts are already contained. */
  egressContained: boolean;
}

const NETWORK_RE = /\b(curl|wget|pip3?\s+install|uv\s+(pip\s+)?(install|add)|npm\s+(i|install|add)|pnpm\s+(add|install)|apt(-get)?\s+install|git\s+clone|ssh|scp|nc)\b/;
const PY_NETWORK_RE = /\b(requests|urllib|httpx|socket|subprocess|os\.system)\b|pip\s+install/;

/** Facts a rule needs that aren't in the tool input, looked up just before deciding. */
export interface CallFacts {
  /** Size of the file `export_artifact` would copy. */
  bytes?: number;
}

export const EXPORT_APPROVAL_BYTES = 50 * 1024 * 1024;

/**
 * The `agent.md` §10.1 matrix (todo1 §3.4). Pure; the extension below applies it.
 *
 * | dataset / environment / plugin reads, patch_environment (undoable)      | allow |
 * | bash / run_python                                                        | allow within budgets |
 * | network-ish commands (curl, wget, pip install, npm i, …)                 | ask unless egress is contained |
 * | upload_dataset_sample on a restricted project                            | ask |
 * | export_artifact over 50 MB                                               | ask |
 * | run_command (Studio commands can change annotations)                     | ask |
 * | anything after a budget is exhausted                                     | deny |
 */
export function decide(
  call: { toolName: string; input: Record<string, unknown> },
  s: PolicyState,
  b: Budgets,
  facts: CallFacts = {},
  now = Date.now(),
): Decision {
  if (s.toolCalls >= b.maxToolCalls) return { kind: "deny", reason: `tool-call budget (${b.maxToolCalls}) exhausted` };
  if ((now - s.startedAt) / 1000 >= b.maxRunSeconds) return { kind: "deny", reason: `run time budget (${b.maxRunSeconds}s) exhausted` };
  if (s.spendUsd >= b.maxSpendUsd) return { kind: "deny", reason: `spend budget ($${b.maxSpendUsd}) exhausted` };

  const str = (k: string) => (typeof call.input[k] === "string" ? (call.input[k] as string) : "");
  switch (call.toolName) {
    case "bash": {
      const cmd = str("command");
      if (NETWORK_RE.test(cmd) && (s.restricted || !s.egressContained)) return { kind: "ask", summary: `Run a command that uses the network: ${cmd.slice(0, 200)}` };
      return { kind: "allow" };
    }
    case "run_python": {
      const code = str("code");
      if (PY_NETWORK_RE.test(code) && (s.restricted || !s.egressContained)) return { kind: "ask", summary: "Run Python that may use the network or spawn processes" };
      return { kind: "allow" };
    }
    case "export_artifact":
      return (facts.bytes ?? 0) > EXPORT_APPROVAL_BYTES
        ? { kind: "ask", summary: `Export a ${Math.round((facts.bytes ?? 0) / 1024 / 1024)} MB file from the sandbox: ${str("path").slice(0, 200)}` }
        : { kind: "allow" };
    case "run_command":
      // Studio commands can create or change annotations (e.g. detectBeats); the expert confirms each one.
      return { kind: "ask", summary: `Run the Studio command ${str("id") || "(unnamed)"}` };
    case "upload_dataset_sample":
      return s.restricted ? { kind: "ask", summary: "Copy restricted dataset files into the sandbox" } : { kind: "allow" };
    default:
      return { kind: "allow" };
  }
}

export function previewInput(input: Record<string, unknown>, max = 600): string {
  const s = JSON.stringify(input, (_k, v) => (typeof v === "string" && v.length > 400 ? `${v.slice(0, 400)}…` : v));
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** pi extension: every tool call passes through `decide`; `ask` blocks on the approval broker. */
export function policyExtension(opts: {
  state: () => PolicyState;
  budgets: Budgets;
  approvals: ApprovalBroker;
  signal: () => AbortSignal | undefined;
  onCall?: (toolName: string) => void;
  onAwaiting?: (waiting: boolean) => void;
  facts?: (toolName: string, input: Record<string, unknown>) => Promise<CallFacts>;
}): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (e) => {
      const input = e.input as Record<string, unknown>;
      // A failed lookup leaves the fact unknown; rules treat unknown as the permissive case only
      // where the tool itself enforces a hard limit (export_artifact's size cap).
      const facts = (await opts.facts?.(e.toolName, input).catch(() => ({}))) ?? {};
      const d = decide({ toolName: e.toolName, input }, opts.state(), opts.budgets, facts);
      if (d.kind === "deny") return { block: true, reason: d.reason, terminate: true };
      if (d.kind === "ask") {
        opts.onAwaiting?.(true);
        const res = await opts.approvals
          .request({ toolCallId: e.toolCallId, toolName: e.toolName, summary: d.summary, inputPreview: previewInput(e.input as Record<string, unknown>) }, opts.signal())
          .finally(() => opts.onAwaiting?.(false));
        if (res.decision !== "approve") return { block: true, reason: `The user declined this action${res.note ? `: ${res.note}` : ""}.` };
      }
      opts.onCall?.(e.toolName);
      return undefined;
    });
  };
}
