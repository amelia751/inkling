import { useEffect, useMemo, useRef, useState } from "react";
import { labelColor } from "@studio/plugin-ui-sdk/labels";
import { labelNames } from "@studio/contracts/environment";
import type { RendererProps } from "@studio/plugin-ui-sdk/module";
import { isTextSpan, type TextSpan } from "./manifest";
import { segments, snap, spanGeometry } from "./spans";
import { assetUrl, isEditable, newAnnotation, useHost, visibleFor } from "@studio/plugin-ui-sdk";

/**
 * Reading view for one text item. With the Span tool, selecting text labels it with the
 * active class; clicking a highlighted span selects it (Shift/⌘ adds). Deleting, undo and
 * label picking are the Studio's core commands.
 */
export function TextReader({ item, project, runtime }: RendererProps) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const annotations = useHost((s) => s.annotations);
  const hidden = useHost((s) => s.hiddenLabels);
  const selectedIds = useHost((s) => s.selectedIds);
  const tool = useHost((s) => s.tool);
  const labels = labelNames(project.labels);

  useEffect(() => {
    let live = true;
    fetch(assetUrl(item.assets[0].path))
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status} ${r.statusText}`))))
      .then((t) => live && setText(t))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [item]);

  const spans = useMemo(
    () => visibleFor(annotations, item.id, hidden).filter(isTextSpan).map((a) => ({ id: a.id, label: a.label, ...(a.geometry as unknown as TextSpan) })),
    [annotations, item.id, hidden],
  );
  const byId = useMemo(() => new Map(spans.map((s) => [s.id, s])), [spans]);
  const segs = useMemo(() => (text === null ? [] : segments(text.length, spans)), [text, spans]);

  useEffect(() => {
    if (text === null) return;
    const status = `${text.length.toLocaleString()} chars · ${spans.length} spans`;
    useHost.getState().setViewerStatus(status);
    runtime.publish("textStats", { chars: text.length, spans: spans.length });
  }, [text, spans.length, runtime]);

  /** Character offset of a DOM position inside the reader. */
  const offsetOf = (node: Node, offset: number): number | null => {
    const el = (node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element))?.closest<HTMLElement>("[data-start]");
    if (!el || !root.current?.contains(el)) return null;
    return Number(el.dataset.start) + (node.nodeType === Node.TEXT_NODE ? offset : 0);
  };

  const onMouseUp = (e: React.MouseEvent) => {
    if (text === null) return;
    const sel = window.getSelection();
    const st = useHost.getState();
    if (tool === "entity" && sel && !sel.isCollapsed && sel.anchorNode && sel.focusNode) {
      const a = offsetOf(sel.anchorNode, sel.anchorOffset), b = offsetOf(sel.focusNode, sel.focusOffset);
      const range = a !== null && b !== null ? snap(text, a, b) : null;
      sel.removeAllRanges();
      if (!range || !st.activeLabel) return;
      const ann = newAnnotation({ itemId: item.id, label: st.activeLabel, geometry: spanGeometry(text, range.start, range.end) as never });
      st.add(ann);
      st.select(ann.id);
      return;
    }
    // A click on a highlight selects its innermost span.
    const seg = (e.target as HTMLElement).closest<HTMLElement>("[data-ids]");
    const id = seg?.dataset.ids?.split(" ").filter(Boolean).at(-1);
    if (!id) return st.select(null);
    if (e.shiftKey || e.metaKey || e.ctrlKey) st.toggleSelect(id);
    else st.select(id);
  };

  if (error) return <div className="p-6 text-sm text-muted-foreground">Couldn't load this document: {error}</div>;
  if (text === null) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  return (
    <div className="h-full overflow-auto bg-background" data-testid="text-reader">
      <div
        ref={root}
        onMouseUp={onMouseUp}
        className="mx-auto max-w-3xl whitespace-pre-wrap px-8 py-6 font-serif text-[15px] leading-7 text-foreground"
        style={{ cursor: tool === "entity" ? "text" : "default" }}
      >
        {segs.map((s) => {
          const inner = s.ids.length ? byId.get(s.ids[s.ids.length - 1]) : undefined;
          const selected = s.ids.some((id) => selectedIds.includes(id));
          const editable = inner ? isEditable(annotations.find((a) => a.id === inner.id)!, useHost.getState().lockedLabels) : true;
          return (
            <span
              key={s.start}
              data-start={s.start}
              data-ids={s.ids.join(" ")}
              title={inner ? `${inner.label}${editable ? "" : " (locked)"}` : undefined}
              style={
                inner
                  ? { background: labelColor(labels, inner.label, selected ? 0.45 : 0.22), boxShadow: selected ? `inset 0 -2px 0 ${labelColor(labels, inner.label)}` : undefined, borderRadius: 2 }
                  : undefined
              }
            >
              {text.slice(s.start, s.end)}
            </span>
          );
        })}
      </div>
    </div>
  );
}
