import type { AgentEvent, AgentStatus, ChatRequest } from "./protocol";

export async function fetchAgentStatus(): Promise<AgentStatus> {
  const res = await fetch("/api/agent/status");
  if (!res.ok) throw new Error(`Agent status ${res.status}`);
  return res.json();
}

/** POST a chat turn and feed each Server-Sent Event to `onEvent` until the run ends. */
export async function streamAgent(request: ChatRequest, onEvent: (e: AgentEvent) => void, signal: AbortSignal): Promise<void> {
  const res = await fetch("/api/agent/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(request),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`The assistant couldn't start (${res.status}).`);
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
      const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (data) onEvent(JSON.parse(data) as AgentEvent);
    }
  }
}
