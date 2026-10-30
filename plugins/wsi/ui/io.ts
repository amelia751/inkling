import { labelNames } from "@studio/plugin-contracts/environment";
import { hslToRgb, resolveLabelColor } from "@studio/plugin-ui-sdk/labels";
import type { Annotation, Geometry, Project, Pt, StudioItem } from "@studio/plugin-contracts/types";
import { measurementLength } from "./measure";
import { regionArea, regionOf, regionPerimeter } from "@studio/studio-renderers/overlay2d/regions";
import { newAnnotation } from "@studio/plugin-ui-sdk";

// ---------------------------------------------------------------- helpers

function labelRgb(labels: string[], label: string): [number, number, number] {
  try {
    return hslToRgb(resolveLabelColor(labels, label)).map(Math.round) as [number, number, number];
  } catch {
    return [200, 0, 0];
  }
}

const hex = (rgb: number[]) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
const close = (r: Pt[]): Pt[] => (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1]) ? [...r, r[0]] : r);
const open = (r: number[][]): Pt[] => {
  const pts = r.map(([x, y]) => [x, y] as Pt);
  return pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1] ? pts.slice(0, -1) : pts;
};
const mppOf = (item: StudioItem | undefined) => item?.assets[0]?.mpp ?? null;
const slideName = (item: StudioItem) => item.assets[0]?.slide ?? item.name;

// ---------------------------------------------------------------- QuPath GeoJSON

interface Feature {
  type: "Feature";
  id?: string;
  geometry: { type: string; coordinates: unknown } | null;
  properties?: Record<string, unknown>;
}

function geojsonGeometry(g: Geometry): Feature["geometry"] {
  const region = regionOf(g);
  if (region) {
    const polys = region.map((p) => p.map(close));
    return polys.length === 1 ? { type: "Polygon", coordinates: polys[0] } : { type: "MultiPolygon", coordinates: polys };
  }
  if (g.type === "keypoint") return { type: "Point", coordinates: [g.x, g.y] };
  if (g.type === "polyline") return { type: "LineString", coordinates: g.points };
  if (g.type === "measurement" && g.space === "image") return { type: "LineString", coordinates: g.points };
  return null;
}

function measurementsOf(a: Annotation, mpp: number | null): Record<string, number> | undefined {
  const region = regionOf(a.geometry);
  const m: Record<string, number> = {};
  if (region) {
    const area = regionArea(region), perim = regionPerimeter(region);
    if (mpp) {
      m["Area µm^2"] = +(area * mpp * mpp).toFixed(2);
      m["Perimeter µm"] = +(perim * mpp).toFixed(2);
    } else {
      m["Area px^2"] = +area.toFixed(1);
      m["Perimeter px"] = +perim.toFixed(1);
    }
  }
  const len = measurementLength(a.geometry);
  if (len !== null) m[mpp ? "Length µm" : "Length px"] = +(mpp ? len * mpp : len).toFixed(2);
  return Object.keys(m).length ? m : undefined;
}

/**
 * QuPath-compatible GeoJSON (File › Import objects / Export objects). Coordinates are level-0
 * pixels. Points are grouped per class into one MultiPoint annotation, as QuPath's points tool does.
 */
export function toQuPathGeoJSON(project: Project, items: StudioItem[], annotations: Annotation[]) {
  const labels = labelNames(project.labels);
  const byId = new Map(items.map((i) => [i.id, i]));
  const features: Feature[] = [];
  const points = new Map<string, { item: string; label: string; coords: number[][] }>();
  for (const a of annotations) {
    const item = byId.get(a.itemId);
    if (!item) continue;
    const g = a.geometry;
    const classification = { name: a.label, color: labelRgb(labels, a.label) };
    if (g.type === "keypoint") {
      const key = `${a.itemId}\u0000${a.label}`;
      const entry = points.get(key) ?? { item: a.itemId, label: a.label, coords: [] };
      entry.coords.push([g.x, g.y]);
      points.set(key, entry);
      continue;
    }
    const geometry = geojsonGeometry(g);
    if (!geometry) continue;
    const name = typeof a.attributes?.name === "string" ? a.attributes.name : undefined;
    features.push({
      type: "Feature",
      id: a.id,
      geometry,
      properties: {
        objectType: "annotation",
        classification,
        isLocked: !!a.locked,
        ...(name ? { name } : {}),
        ...(measurementsOf(a, mppOf(item)) ? { measurements: measurementsOf(a, mppOf(item)) } : {}),
        metadata: { inkling_item: slideName(item), inkling_provenance: a.provenance },
      },
    });
  }
  for (const p of points.values()) {
    features.push({
      type: "Feature",
      id: crypto.randomUUID(),
      geometry: p.coords.length === 1 ? { type: "Point", coordinates: p.coords[0] } : { type: "MultiPoint", coordinates: p.coords },
      properties: {
        objectType: "annotation",
        classification: { name: p.label, color: labelRgb(labels, p.label) },
        isLocked: false,
        measurements: { "Num points": p.coords.length },
        metadata: { inkling_item: slideName(byId.get(p.item)!) },
      },
    });
  }
  return { type: "FeatureCollection", features };
}

/** Parse QuPath (or plain) GeoJSON into annotations for one slide. Unknown geometry types are skipped. */
export function fromGeoJSON(text: string, itemId: string, labels: string[], fallbackLabel: string): { annotations: Annotation[]; skipped: number } {
  const doc = JSON.parse(text);
  const features: Feature[] = Array.isArray(doc) ? doc : doc?.type === "FeatureCollection" ? doc.features : doc?.type === "Feature" ? [doc] : Array.isArray(doc?.features) ? doc.features : [];
  const out: Annotation[] = [];
  let skipped = 0;
  const canonical = (name: string) => labels.find((l) => l.toLowerCase() === name.toLowerCase()) ?? name;
  for (const f of features) {
    const props = f?.properties ?? {};
    const cls = props.classification as { name?: string } | string | undefined;
    const rawLabel = (typeof cls === "string" ? cls : cls?.name) ?? (typeof props.name === "string" && labels.includes(props.name) ? props.name : undefined);
    const label = rawLabel ? canonical(rawLabel) : fallbackLabel;
    const attributes: Record<string, string | number | boolean> = { source: "import" };
    if (typeof props.name === "string") attributes.name = props.name;
    if (typeof props.objectType === "string" && props.objectType !== "annotation") attributes.objectType = props.objectType;
    const base = { itemId, label, attributes, ...(props.isLocked ? { locked: true } : {}) };
    const geoms: Geometry[] = [];
    const g = f?.geometry as { type: string; coordinates: any } | null;
    const c = g?.coordinates;
    switch (g?.type) {
      case "Polygon": {
        const [outer, ...holes] = (c as number[][][]).map(open);
        if (outer?.length >= 3) geoms.push(holes.length ? { type: "polygon", points: outer, holes } : { type: "polygon", points: outer });
        break;
      }
      case "MultiPolygon": {
        const polys = (c as number[][][][]).map((p) => p.map(open)).filter((p) => p[0]?.length >= 3);
        if (polys.length === 1) {
          const [outer, ...holes] = polys[0];
          geoms.push(holes.length ? { type: "polygon", points: outer, holes } : { type: "polygon", points: outer });
        } else if (polys.length) geoms.push({ type: "multipolygon", polygons: polys });
        break;
      }
      case "Point":
        geoms.push({ type: "keypoint", x: c[0], y: c[1] });
        break;
      case "MultiPoint":
        for (const p of c as number[][]) geoms.push({ type: "keypoint", x: p[0], y: p[1] });
        break;
      case "LineString":
        if ((c as number[][]).length >= 2) geoms.push({ type: "polyline", points: (c as number[][]).map(([x, y]) => [x, y] as Pt) });
        break;
      case "MultiLineString":
        for (const l of c as number[][][]) if (l.length >= 2) geoms.push({ type: "polyline", points: l.map(([x, y]) => [x, y] as Pt) });
        break;
      default:
        skipped++;
    }
    for (const geometry of geoms) out.push(newAnnotation({ ...base, geometry, provenance: "human-created" }));
  }
  return { annotations: out, skipped };
}

// ---------------------------------------------------------------- ASAP XML

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * ASAP / CAMELYON annotation XML. ASAP has no holes: inner rings are written as polygons in
 * the group "<label>_exclusion" (the CAMELYON convention for excluded areas). Ellipses become
 * Polygons, polylines Splines, length measurements Measurements, and each class's points one PointSet.
 */
export function toAsapXml(project: Project, items: StudioItem[], annotations: Annotation[]): string {
  const labels = labelNames(project.labels);
  const ids = new Set(items.map((i) => i.id));
  const lines: string[] = [];
  const groups = new Set<string>();
  let n = 0;
  const emit = (type: string, group: string, pts: number[][]) => {
    groups.add(group);
    const color = hex(labelRgb(labels, group.replace(/_exclusion$/, "")));
    lines.push(`    <Annotation Name="Annotation ${n++}" Type="${type}" PartOfGroup="${esc(group)}" Color="${color}">`);
    lines.push("      <Coordinates>");
    pts.forEach(([x, y], i) => lines.push(`        <Coordinate Order="${i}" X="${x}" Y="${y}" />`));
    lines.push("      </Coordinates>");
    lines.push("    </Annotation>");
  };
  const points = new Map<string, number[][]>();
  for (const a of annotations) {
    if (!ids.has(a.itemId)) continue;
    const g = a.geometry;
    if (g.type === "keypoint") {
      const list = points.get(a.label) ?? [];
      list.push([g.x, g.y]);
      points.set(a.label, list);
    } else if (g.type === "box") {
      emit("Rectangle", a.label, [[g.x, g.y], [g.x + g.w, g.y], [g.x + g.w, g.y + g.h], [g.x, g.y + g.h]]);
    } else if (g.type === "polyline") {
      emit("Spline", a.label, g.points);
    } else if (g.type === "measurement" && g.space === "image") {
      emit("Measurement", a.label, g.points);
    } else {
      const region = regionOf(g);
      if (!region) continue;
      for (const [outer, ...holes] of region) {
        emit("Polygon", a.label, outer);
        for (const h of holes) emit("Polygon", `${a.label}_exclusion`, h);
      }
    }
  }
  for (const [label, pts] of points) emit(pts.length === 1 ? "Dot" : "PointSet", label, pts);
  const groupXml = [...groups].map((g) => `    <Group Name="${esc(g)}" PartOfGroup="None" Color="${hex(labelRgb(labels, g.replace(/_exclusion$/, "")))}">\n      <Attributes />\n    </Group>`);
  return ['<?xml version="1.0"?>', "<ASAP_Annotations>", "  <Annotations>", ...lines, "  </Annotations>", "  <AnnotationGroups>", ...groupXml, "  </AnnotationGroups>", "</ASAP_Annotations>", ""].join("\n");
}

// ---------------------------------------------------------------- CSV

/** One row per slide × class: point count, region count and total region area. */
export function toCountsCsv(project: Project, items: StudioItem[], annotations: Annotation[]): string {
  const labels = labelNames(project.labels);
  const rows = ["slide,class,points,regions,region_area,area_unit,points_per_mm2"];
  for (const item of items) {
    const mpp = mppOf(item);
    const mine = annotations.filter((a) => a.itemId === item.id);
    const classes = [...new Set([...labels, ...mine.map((a) => a.label)])];
    for (const label of classes) {
      const of = mine.filter((a) => a.label === label);
      const pts = of.filter((a) => a.geometry.type === "keypoint").length;
      let area = 0, regions = 0;
      for (const a of of) {
        const r = regionOf(a.geometry);
        if (r) {
          regions++;
          area += regionArea(r);
        }
      }
      const physical = mpp ? area * mpp * mpp : area;
      const density = mpp && area ? (pts / (area * mpp * mpp * 1e-6)).toFixed(1) : "";
      rows.push([JSON.stringify(slideName(item)), JSON.stringify(label), pts, regions, physical.toFixed(mpp ? 1 : 0), mpp ? "um2" : "px2", density].join(","));
    }
  }
  return rows.join("\n") + "\n";
}
