import type { Pt } from "@/types";
import { dragHandle, deleteVertex, editRings, handlesOf, HANDLE_RADIUS, insertVertex, cloneGeometry, type HandleRef } from "../edit";
import { hitEdge, pointInPolygon } from "../geometry";
import { pointInRegion, ringsBounds, translateGeometry } from "../regions";
import type { Entry } from "../scene";
import { dist, type Draft, type ToolContext, type ToolMachine } from "./types";

type EditDraft = Extract<Draft, { kind: "edit" }>;
type AreaDraft = Extract<Draft, { kind: "area" }>;

export interface Hit {
  entry: Entry;
  handle?: HandleRef;
  edge?: { ring: number; index: number };
}

/**
 * What the select tool would grab at a screen point: a handle or edge of the (editable)
 * primary selection first, then the topmost object. Clicking inside the selected region
 * keeps it even when a smaller object overlaps there.
 */
export function hitAt(ctx: Pick<ToolContext, "view" | "scene" | "selected" | "editable">, screen: Pt): Hit | null {
  const v = ctx.view;
  const p = v.toImage(...screen);
  const tol = 6 / v.scale;
  const sel = ctx.selected();
  if (sel && ctx.editable(sel.a)) {
    const g = sel.a.geometry;
    const handles = handlesOf(g, v);
    let best = -1, bestD = HANDLE_RADIUS;
    handles.forEach((h, i) => {
      const d = dist(h.s, screen);
      if (d <= bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best >= 0) return { entry: sel, handle: handles[best].ref };
    const er = editRings(g);
    if (er && handles.length) {
      for (let ri = 0; ri < er.rings.length; ri++) {
        const index = hitEdge(p, er.rings[ri], tol, er.closed);
        if (index >= 0) return { entry: sel, edge: { ring: ri, index } };
      }
    }
  }
  const hit = ctx.scene.hitTest(p, tol);
  if (!hit) return null;
  if (sel && hit !== sel && sel.kind === "region" && hit.kind === "region" && pointInRegion(p, sel.region!) && sel.area < hit.area) return { entry: sel };
  return { entry: hit };
}

/** Ids whose bbox centre falls inside the screen-space rectangle / lasso. */
export function areaHits(ctx: Pick<ToolContext, "view" | "scene">, d: AreaDraft): string[] {
  const v = ctx.view;
  let poly: Pt[] = d.points;
  if (d.mode === "rect") {
    const [[x0, y0], [x1, y1]] = [d.points[0], d.points[d.points.length - 1]];
    poly = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  }
  if (poly.length < 3) return [];
  const img = poly.map((q) => v.toImage(...q));
  const [minX, minY, maxX, maxY] = ringsBounds([img]);
  const out: string[] = [];
  for (const k of ctx.scene.search(minX, minY, maxX, maxY)) {
    const e = ctx.scene.entries[k];
    const c = v.toScreen((e.bbox[0] + e.bbox[2]) / 2, (e.bbox[1] + e.bbox[3]) / 2);
    if (pointInPolygon(c, poly)) out.push(e.a.id);
  }
  return out;
}

/**
 * Select / move / reshape. Click selects (Shift toggles), dragging a body moves it (and
 * every selected object when it is part of a multi-selection, as one undo step), dragging
 * a handle reshapes, clicking an edge inserts a vertex, Alt-clicking a vertex deletes it.
 * On empty canvas Shift-drag is a rectangle and Alt-drag a lasso selection; a plain drag
 * is left to the host (pan) and a plain click clears the selection.
 */
export function selectTool(): ToolMachine {
  let d: EditDraft | AreaDraft | null = null;

  const finishEdit = (e: EditDraft, ctx: ToolContext) => {
    const s = ctx.store();
    if (!e.moved) {
      if (e.clickSelect) s.select(e.clickSelect);
      if (e.insert) {
        const g = insertVertex(e.base, e.insert.ring, e.insert.index, e.insert.p);
        if (g) s.update(e.id, { geometry: g });
      }
      return;
    }
    if (e.group?.length) s.batch({ update: e.group.map((g) => ({ id: g.id, patch: { geometry: g.geometry } })) });
    else s.update(e.id, { geometry: e.geometry });
  };

  return {
    needsLabel: false,
    cursor: "",
    down(e, ctx) {
      const s = ctx.store();
      const hit = hitAt(ctx, e.screen);
      if (!hit) {
        if (e.shift || e.alt) {
          d = { kind: "area", mode: e.alt ? "lasso" : "rect", points: [e.screen, e.screen], additive: e.shift };
          return "claim";
        }
        ctx.deselectOnClick(e.screen);
        return "pass";
      }
      const a = hit.entry.a;
      if (e.shift && !hit.handle) {
        s.toggleSelect(a.id);
        return "consume";
      }
      const inMulti = !hit.handle && s.selectedIds.length > 1 && s.selectedIds.includes(a.id);
      if (!inMulti && (s.selectedId !== a.id || s.selectedIds.length > 1)) s.select(a.id);
      // Locked: selectable, and dragging still pans.
      if (!ctx.editable(a)) return "pass";
      if (hit.handle && e.alt) {
        const g = deleteVertex(a.geometry, hit.handle);
        if (g) s.update(a.id, { geometry: g });
        return "consume";
      }
      const base = a.geometry;
      const group = inMulti
        ? s.selectedIds
            .map((id) => ctx.scene.get(id))
            .filter((x): x is Entry => !!x && ctx.editable(x.a))
            .map((x) => ({ id: x.a.id, base: x.a.geometry, geometry: x.a.geometry }))
        : undefined;
      d = {
        kind: "edit",
        id: a.id,
        base,
        geometry: hit.handle ? cloneGeometry(base) : base,
        mode: hit.handle ? "handle" : "move",
        handle: hit.handle,
        start: e.p,
        startScreen: e.screen,
        moved: false,
        insert: hit.edge ? { ring: hit.edge.ring, index: hit.edge.index, p: e.p } : undefined,
        group,
        clickSelect: inMulti ? a.id : undefined,
      };
      return "claim";
    },
    move(e) {
      if (!d) return;
      if (d.kind === "area") {
        if (d.mode === "rect") d.points[1] = e.screen;
        else if (dist(e.screen, d.points[d.points.length - 1]) > 3) d.points.push(e.screen);
        return;
      }
      if (!d.moved && dist(e.screen, d.startScreen) < 3) return;
      d.moved = true;
      if (d.mode === "move") {
        const dx = e.p[0] - d.start[0], dy = e.p[1] - d.start[1];
        d.geometry = translateGeometry(d.base, dx, dy);
        if (d.group) for (const g of d.group) g.geometry = translateGeometry(g.base, dx, dy);
      } else d.geometry = dragHandle(d.geometry, d.base, d.handle!, e.p);
    },
    up(_e, ctx) {
      const cur = d;
      d = null;
      if (!cur) return;
      if (cur.kind === "edit") return finishEdit(cur, ctx);
      const s = ctx.store();
      const [a, b] = [cur.points[0], cur.points[cur.points.length - 1]];
      if (cur.mode === "rect" && dist(a, b) < 3) return;
      const hits = areaHits(ctx, cur);
      s.selectMany(cur.additive ? [...new Set([...s.selectedIds, ...hits])] : hits);
    },
    cancel() {
      d = null;
    },
    draft: () => d,
  };
}
