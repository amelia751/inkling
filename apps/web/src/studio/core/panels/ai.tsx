import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type Anthropic from "@anthropic-ai/sdk";
import { AiIcon, CloseIcon, InfoIcon, SendIcon, UndoIcon } from "@studio/studio-ui/icons";
import { Button } from "@studio/studio-ui/ui/button";
import { Textarea } from "@studio/studio-ui/ui/textarea";
import { installEnvironment, persistEnvironment } from "@/studio/lib/environment-edits";
import { AGENT_TOOLS, agentSystemPrompt, changedKeys, environmentContext, runAgentTool, type AgentHost } from "@/extension-host/agent";
import type { PanelProps } from "@studio/plugin-ui-sdk/module";
import { useStudio } from "@/studio/stores/studio";
import { NAMING } from "@studio/plugin-contracts/naming";

type Msg = Anthropic.Beta.BetaMessageParam;
type Block = Anthropic.Beta.BetaContentBlock;

/** What the panel shows; the API transcript (`Msg[]`) is kept separately and sent whole. */
type Entry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; ok: boolean; detail?: string }
  | { kind: "change"; summary: string; keys: string[]; undone?: boolean }
  | { kind: "error"; text: string };

const SAMPLE_PROMPTS = [
  "Add a polygon tool and a “car” class in red",
  "Which export formats can I use here?",
  "Hide the review tab",
  "Bind fit-to-view to F",
];
const MAX_TOOL_ROUNDS = 12;

/**
 * `inkling.core.panels.ai`: the assistant that edits the running environment through the
 * agent tools (platform/agent.ts). The browser runs the tool loop so every edit is a normal
 * undoable `setEnv` step; the dev server only relays Messages API calls (/api/agent).
 * Manual annotation never depends on this panel.
 */
export function AiPanel({ project, item }: PanelProps) {
  const toggleAi = useStudio((s) => s.toggleAi);
  const status = useQuery({ queryKey: ["agent-status"], queryFn: () => fetch("/api/agent/status").then((r) => (r.ok ? r.json() : { available: false })), staleTime: Infinity, retry: false });
  const available = status.data?.available === true;
  const [entries, setEntries] = useState<Entry[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const transcript = useRef<Msg[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const push = (e: Entry) => setEntries((list) => [...list, e]);

  useEffect(() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight }), [entries]);

  const host: AgentHost = {
    env: () => useStudio.getState().env,
    apply: async (env, summary) => {
      const before = useStudio.getState().env;
      await installEnvironment(env);
      push({ kind: "change", summary, keys: before ? changedKeys(before.source, env.source) : [] });
      await persistEnvironment(project.id, env, `agent:${status.data?.model ?? "claude"}`).catch((e) => push({ kind: "error", text: `Applied, but not saved: ${e instanceof Error ? e.message : e}` }));
    },
  };

  const undo = async (index: number) => {
    useStudio.getState().undoEnv();
    setEntries((list) => list.map((e, i) => (i === index && e.kind === "change" ? { ...e, undone: true } : e)));
    const env = useStudio.getState().env;
    if (env) await persistEnvironment(project.id, env, "local-expert").catch(() => undefined);
    transcript.current.push({ role: "user", content: [{ type: "text", text: "(The expert undid your last environment change.)" }] });
  };

  const send = async (text: string) => {
    if (!text.trim() || busy) return;
    setDraft("");
    setBusy(true);
    push({ kind: "user", text });
    const state = `${environmentContext(useStudio.getState().env)}\nCurrent item: ${item?.name ?? "none"}`;
    transcript.current.push({ role: "user", content: [{ type: "text", text: `${state}\n\n${text}` }] });
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const res = await fetch("/api/agent/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ system: agentSystemPrompt(), tools: AGENT_TOOLS, messages: transcript.current }),
        });
        const msg = await res.json();
        if (!res.ok) throw new Error(msg.error ?? `${res.status}`);
        const content = msg.content as Block[];
        // Append the full content (thinking and fallback blocks included), never just the text.
        transcript.current.push({ role: "assistant", content: content as unknown as Anthropic.Beta.BetaContentBlockParam[] });
        const said = content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
        if (said) push({ kind: "assistant", text: said });
        if (msg.stop_reason === "refusal") throw new Error("The assistant declined this request.");
        if (msg.stop_reason === "max_tokens") throw new Error("The reply was cut off; try a narrower request.");
        if (msg.stop_reason !== "tool_use") break;
        const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
        for (const b of content) {
          if (b.type !== "tool_use") continue;
          const out = await runAgentTool(b.name, (b.input ?? {}) as Record<string, unknown>, host);
          push({ kind: "tool", name: b.name, ok: out.ok, detail: out.ok ? undefined : JSON.stringify(out.errors ?? out.error) });
          results.push({ type: "tool_result", tool_use_id: b.id, content: JSON.stringify(out), is_error: !out.ok });
        }
        // Every tool result of the turn goes back in one user message.
        transcript.current.push({ role: "user", content: results });
      }
    } catch (e) {
      push({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="flex h-full flex-col bg-[var(--bg-primary)]" aria-label={`${NAMING.displayName} AI`}>
      <div className="flex h-10 items-center gap-2 border-b border-[var(--border-color)] px-3">
        <AiIcon className="size-4 text-ai-text" />
        <span className="text-sm font-medium">{NAMING.displayName} AI</span>
        <button onClick={toggleAi} className="ml-auto rounded p-1 text-muted-foreground hover:bg-[var(--bg-tertiary)]" aria-label="Close assistant">
          <CloseIcon className="h-3.5 w-3.5" />
        </button>
      </div>
      <div ref={scroller} className="flex-1 space-y-3 overflow-y-auto p-3 text-sm" data-testid="agent-log">
        <div className="rounded-md bg-[var(--bg-secondary)] p-2.5 text-xs">
          <div className="text-muted-foreground">Context</div>
          <div className="mt-0.5 truncate font-medium">{project.title}</div>
          {item && <div className="truncate text-muted-foreground">{item.name}</div>}
        </div>
        {!available && !status.isLoading && (
          <div className="flex gap-2 rounded-md border border-[var(--border-color)] p-2.5 text-xs text-muted-foreground">
            <InfoIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <p>
              The assistant isn't connected. Set <code className="font-mono">ANTHROPIC_API_KEY</code> (or run <code className="font-mono">ant auth login</code>) and restart the dev server. Everything else in the Studio works without it.
            </p>
          </div>
        )}
        {entries.map((e, i) => <EntryView key={i} entry={e} onUndo={() => undo(i)} />)}
        {busy && <div className="text-xs text-muted-foreground">Working…</div>}
        {!entries.length && (
          <div className="space-y-1.5">
            <div className="text-xs text-muted-foreground">Try asking</div>
            {SAMPLE_PROMPTS.map((p) => (
              <button key={p} disabled={!available || busy} onClick={() => send(p)} className="block w-full rounded-md border border-[var(--border-color)] px-2.5 py-1.5 text-left text-xs text-muted-foreground hover:bg-[var(--bg-tertiary)] disabled:opacity-60">
                {p}
              </button>
            ))}
          </div>
        )}
      </div>
      <form
        className="border-t border-[var(--border-color)] p-2"
        onSubmit={(e) => {
          e.preventDefault();
          send(draft);
        }}
      >
        <div className="flex items-end gap-1.5">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(draft);
              }
            }}
            disabled={!available}
            placeholder={available ? `Ask ${NAMING.displayName} to change this environment…` : `Ask ${NAMING.displayName}…`}
            className="min-h-9 resize-none text-sm"
            rows={1}
          />
          <Button type="submit" size="icon" disabled={!available || busy || !draft.trim()} className="h-9 w-9 shrink-0" aria-label="Send">
            <SendIcon className="h-4 w-4" />
          </Button>
        </div>
      </form>
    </aside>
  );
}

function EntryView({ entry: e, onUndo }: { entry: Entry; onUndo: () => void }) {
  switch (e.kind) {
    case "user":
      return <div className="ml-6 rounded-md bg-accent px-2.5 py-1.5">{e.text}</div>;
    case "assistant":
      return <div className="whitespace-pre-wrap">{e.text}</div>;
    case "tool":
      return (
        <div className="truncate font-mono text-[11px] text-muted-foreground" title={e.detail}>
          {e.ok ? "✓" : "✗"} {e.name}
          {e.detail && ` · ${e.detail}`}
        </div>
      );
    case "change":
      return (
        <div className="flex items-start gap-2 rounded-md border border-[var(--border-color)] bg-prov-ai/10 px-2.5 py-1.5 text-xs" data-testid="agent-change">
          <div className="min-w-0 flex-1">
            <div className={e.undone ? "line-through text-muted-foreground" : "font-medium"}>Agent changed: {e.summary}</div>
            {e.keys.length > 0 && <div className="text-muted-foreground">{e.keys.join(", ")}</div>}
          </div>
          {!e.undone && (
            <button onClick={onUndo} className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-[var(--bg-tertiary)] hover:text-foreground">
              <UndoIcon className="h-3 w-3" /> Undo
            </button>
          )}
        </div>
      );
    case "error":
      return <div className="rounded-md bg-warning-tint px-2.5 py-1.5 text-xs">{e.text}</div>;
  }
}
