import { useEffect, useRef } from "react";
import { create } from "zustand";
import type { DatasetSnapshot } from "@studio/agent-protocol";
import type { AttentionItem, ProjectOverview, Proposal, SourceNode } from "@studio/contracts/types";

/**
 * What the assistant can see, per project section (todo6 Phase 6, docs/ux.md §9). Each page
 * registers one provider with `useAgentContext(provider)`; the assistant (the project drawer or
 * the Studio's panel) sends its `turnContext()` with every message, and the Studio's also sends
 * the dataset `snapshot()`. A `ContextIndicator` chip shows `label`, and the person can remove
 * it: then nothing about the selection is sent until the context changes.
 *
 * Providers never include file contents, and never anything about a file held for privacy
 * review (see `sourceNodeContext`).
 */
export type AgentSection = "overview" | "sources" | "explore" | "datasets" | "studio" | "review" | "activity" | "settings";

export interface AgentContextProvider {
  /** Changes when what's shared changes (another selection), which brings a removed chip back. */
  key: string;
  section: AgentSection;
  /** Chip text, e.g. "Sources › MRI/patient_002". */
  label: string;
  /** Chip tooltip: what is shared, in plain words. */
  shares: string;
  /** Text for the model with each message (inside <studio_context>). */
  turnContext(): string;
  /** The Studio only: the dataset snapshot its dataset tools read. */
  snapshot?(): DatasetSnapshot;
}

interface AgentContextState {
  provider: AgentContextProvider | null;
  /** Key of the provider whose chip the person removed. */
  dismissed: string | null;
  register: (p: AgentContextProvider) => void;
  unregister: (key: string) => void;
  dismiss: () => void;
  restore: () => void;
}

export const useAgentContextStore = create<AgentContextState>((set, get) => ({
  provider: null,
  dismissed: null,
  register: (provider) => set({ provider }),
  unregister: (key) => {
    if (get().provider?.key === key) set({ provider: null });
  },
  dismiss: () => set((s) => ({ dismissed: s.provider?.key ?? null })),
  restore: () => set({ dismissed: null }),
}));

/**
 * Register what the assistant can see on this page (pass `null` while nothing is loaded). Call
 * it once per page with a provider built from the page's state, e.g.
 * `useAgentContext(useMemo(() => sourceNodeContext(project, node), [project, node]))`.
 * The latest provider object is used at send time, so `turnContext()` may read live state.
 */
export function useAgentContext(provider: AgentContextProvider | null): void {
  const latest = useRef(provider);
  latest.current = provider;
  const key = provider?.key;
  const label = provider?.label;
  useEffect(() => {
    const p = latest.current;
    if (!p || !key) return;
    // A proxy keeps the store's object stable while reading the page's latest provider.
    const live: AgentContextProvider = {
      key,
      section: p.section,
      label: label ?? p.label,
      shares: p.shares,
      turnContext: () => (latest.current ?? p).turnContext(),
      snapshot: p.snapshot && (() => (latest.current ?? p).snapshot!()),
    };
    useAgentContextStore.getState().register(live);
    return () => useAgentContextStore.getState().unregister(key);
  }, [key, label]);
}

/** The provider the assistant should use in `section`: the page's own, else the section itself. */
export function currentProvider(p: AgentContextProvider | null, section: AgentSection, project: ProjectRef): AgentContextProvider {
  return p && p.section === section ? p : sectionContext(project, section);
}

export interface ProjectRef {
  id: string;
  title: string;
  restricted?: boolean;
}

const SECTION_LABEL: Record<AgentSection, string> = {
  overview: "Overview",
  sources: "Sources",
  explore: "Explore",
  datasets: "Datasets",
  studio: "Studio",
  review: "Review",
  activity: "Activity",
  settings: "Settings",
};

const head = (project: ProjectRef, section: AgentSection) => [`Project: ${project.title} (${project.id})${project.restricted ? " · restricted licence: structure only, no file names" : ""}`, `Section: ${SECTION_LABEL[section]}`];

/** Just the section: the assistant knows where the person is and looks the rest up with its tools. */
export function sectionContext(project: ProjectRef, section: AgentSection): AgentContextProvider {
  return {
    key: `${project.id}:${section}`,
    section,
    label: SECTION_LABEL[section],
    shares: `Which project and section you're in. The assistant looks up the rest (sources, proposals, imports) with its tools, never file contents.`,
    turnContext: () => [...head(project, section), "Selected: nothing"].join("\n"),
  };
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Overview: the project summary (data cards, tasks, what needs attention; held files counted only). */
export function overviewContext(o: ProjectOverview): AgentContextProvider {
  const project = { id: o.project.id, title: o.project.title, restricted: o.project.restricted };
  const attention = o.attention ?? [];
  const held = attention.filter((a) => a.type === "privacy").length;
  const line = (a: AttentionItem) => (a.type === "privacy" ? null : `- ${a.title}${project.restricted ? "" : `: ${a.detail}`}`);
  return {
    key: `${o.project.id}:overview:${o.data?.length ?? 0}:${o.attentionTotal ?? attention.length}`,
    section: "overview",
    label: "Overview",
    shares: "The project summary: its data cards (kinds and counts), tasks and what needs attention. Held files are counted, never named.",
    turnContext: () =>
      [
        ...head(project, "overview"),
        `Data: ${(o.data ?? []).map((d) => `${d.count} ${d.kindLabel.toLowerCase()} (${d.type} ${project.restricted ? d.id : d.title})`).join("; ") || "none yet"}`,
        `Tasks: ${o.tasks.map((t) => `${t.title} (${t.kind}, ${t.id})`).join("; ") || "none"}`,
        `Needs attention: ${o.attentionTotal ?? attention.length}`,
        ...attention.map(line).filter((l): l is string => !!l),
        ...(held ? [`${plural(held, "file")} held for privacy review (not shared).`] : []),
      ].join("\n"),
  };
}

const isHeld = (n: Pick<SourceNode, "status" | "flags">) => n.status === "privacy" || !!(n.flags?.privacy && !n.flags.privacy.clearedBy);

/**
 * Sources: the selected node and its facts, never file contents. A held file is only "a file
 * held for privacy review"; a restricted project shares its kind and status, not its name.
 */
export function sourceNodeContext(project: ProjectRef, node: SourceNode | null | undefined): AgentContextProvider {
  if (!node) return sectionContext(project, "sources");
  const held = isHeld(node);
  const named = !held && !project.restricted;
  const name = node.displayPath ?? node.name;
  const label = held ? "Sources › a held file" : named ? `Sources › ${name}` : `Sources › a ${node.detectedKind ?? node.kind}`;
  const facts = named ? node.facts : Object.fromEntries(Object.entries(node.facts ?? {}).filter(([, v]) => typeof v === "number" || typeof v === "boolean"));
  return {
    key: `${project.id}:sources:${node.id}`,
    section: "sources",
    label,
    shares: held ? "Only that a file held for privacy review is selected: nothing about it is shared." : "The selected file or folder: its name, kind, status and detected facts. Never its contents.",
    turnContext: () =>
      [
        ...head(project, "sources"),
        held
          ? `Selected: a file held for privacy review (${node.id}); its details are not shared.`
          : `Selected: ${named ? `${name} ` : ""}(${node.kind}, ${node.detectedKind ?? "unknown kind"}, ${node.status}, id ${node.id})`,
        ...(!held && node.kind !== "file" ? [`Contains: ${plural(node.descendantCount, "file")}`] : []),
        ...(!held && Object.keys(facts ?? {}).length ? [`Facts: ${JSON.stringify(facts).slice(0, 2000)}`] : []),
      ].join("\n"),
  };
}

/** Explore: the selected proposal (its kind, strength, payload and evidence). */
export function proposalContext(project: ProjectRef, proposal: Proposal | null | undefined): AgentContextProvider {
  if (!proposal) return sectionContext(project, "explore");
  const kind = proposal.kind === "mapping" ? "table layout" : proposal.kind;
  return {
    key: `${project.id}:explore:${proposal.id}:${proposal.status}`,
    section: "explore",
    label: `Explore › Proposed ${kind}`,
    shares: "The selected proposal: what it proposes, how strong the match is and its evidence.",
    turnContext: () =>
      [
        ...head(project, "explore"),
        `Selected proposal: ${proposal.id} (${proposal.kind}, ${proposal.strength} match, ${proposal.status}, by ${proposal.createdBy})`,
        ...(project.restricted ? [] : [`Payload: ${JSON.stringify(proposal.payload).slice(0, 2000)}`, `Evidence: ${JSON.stringify(proposal.evidence).slice(0, 2000)}`]),
        "Only the user can confirm it, here in Explore.",
      ].join("\n"),
  };
}
