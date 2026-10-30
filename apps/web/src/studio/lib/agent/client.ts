import type {
  AgentEvent,
  AgentStatus,
  ApprovalDecisionRequest,
  ClientToolResultRequest,
  CreateSessionRequest,
  CreateSessionResponse,
  SendMessageRequest,
  SendMessageResponse,
} from "./protocol";
import { runtimeConfig } from "@/extension-host/runtime-config";

/**
 * HTTP client for the agent service, through a proxy that maps <agentBase> (`/api/agent`) to the
 * service's /v1 and adds its bearer token: the Vite proxy in dev, the web image's nginx in production.
 */
const BASE = () => runtimeConfig().agentBase;

export class AgentHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BASE()}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const msg = await res.json().then((j: { error?: string }) => j.error, () => undefined);
    throw new AgentHttpError(res.status, msg ?? (res.status === 502 || res.status === 504 ? "The agent service isn't running (pnpm agent)." : `Agent service error ${res.status}`));
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const fetchAgentStatus = () => call<AgentStatus>("GET", "/status");
export const createSession = (req: CreateSessionRequest) => call<CreateSessionResponse>("POST", "/sessions", req);
export const deleteSession = (sessionId: string) => call<void>("DELETE", `/sessions/${sessionId}`);
export const sendMessage = (sessionId: string, req: SendMessageRequest) => call<SendMessageResponse>("POST", `/sessions/${sessionId}/messages`, req);
export const cancelRun = (runId: string) => call<unknown>("POST", `/runs/${runId}/cancel`);
export const answerClientTool = (runId: string, callId: string, result: ClientToolResultRequest) =>
  call<unknown>("POST", `/runs/${runId}/client-tools/${encodeURIComponent(callId)}`, result);
export const decideApproval = (approvalId: string, d: ApprovalDecisionRequest) => call<unknown>("POST", `/approvals/${approvalId}`, d);
export const artifactUrl = (artifactId: string) => `${BASE()}/artifacts/${encodeURIComponent(artifactId)}`;

const RETRY_MS = [500, 1000, 2000, 4000, 8000];

/**
 * Follow a run's event stream from `after` until its `done` event. Reconnects (from the last seq
 * seen) when the connection drops; a 404 means the run is gone (e.g. the service restarted).
 * Uses fetch rather than EventSource so it can stop on `done`, report HTTP errors and abort.
 */
export async function followRun(runId: string, after: number, onEvent: (e: AgentEvent) => void | Promise<void>, signal: AbortSignal): Promise<void> {
  let last = after;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${BASE()}/runs/${runId}/events?after=${last}`, { headers: { Accept: "text/event-stream" }, signal });
      if (res.status === 404) throw new AgentHttpError(404, "This run is no longer available.");
      if (!res.ok || !res.body) throw new AgentHttpError(res.status, `Event stream failed (${res.status}).`);
      attempt = 0;
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let cut: number;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const data = frame
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          const e = JSON.parse(data) as AgentEvent;
          if (e.seq && e.seq <= last) continue;
          await onEvent(e);
          if (e.seq) last = e.seq;
          if (e.type === "done") return;
        }
      }
    } catch (err) {
      if (signal.aborted || (err instanceof AgentHttpError && err.status === 404)) throw err;
      if (attempt >= RETRY_MS.length) throw err;
    }
    // The stream ended without `done` (proxy hiccup, service restart): reconnect from `last`.
    await new Promise((r) => setTimeout(r, RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]));
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
  }
}
