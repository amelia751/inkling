import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * The read-only project API without the kernel (todo6 D4): seed-data/manifest.json
 * synthesized into projects, sources, datasets and tasks, the same shapes and ids as
 * apps/api (kernel/projects.py, tree.py, overview.py), so Overview, Sources browsing and the
 * Studio work on the Vite dev server and in apps/web/e2e. Resume state is kept in
 * `resumeDir` (seed-data/.resume/, a temp folder in e2e runs). Every other write answers
 * 501 `{ error: "needs the API" }`: adding data needs the full stack (docs/running.md).
 *
 *   GET  /api/v1/projects[/:id[/overview|/sources|/datasets[/:d[/profile]]|/search|/imports|/proposals|/review|/activity|/resume]]
 *   GET  /api/v1/projects/:id/dataset-summaries, /dataset-attention?datasetId= (routes/datasets_views.py)
 *   GET  /api/v1/datasets/:d/structure               → 404 (no structure draft; todo13-organize stores one)
 *   PUT  /api/v1/projects/:id/resume
 *   GET  /api/v1/sources/:id/children?node=&cursor=
 *   GET  /api/v1/source-nodes/:id[/preview]
 *   GET  /api/v1/tasks/:id[/document]
 *   todo7 (docs/files-api.md "Seed stand-in", D12): the drive, read-only —
 *   GET  /api/v1/projects/:id/fs                      → { rootNodeId, writable: false, trashCount: 0 }
 *   GET  /api/v1/projects/:id/fs/children?node=&cursor=&limit=&sort=&dir= → a synthetic "Files" root whose
 *                                                       child is the sample's folder; below it, like /sources children
 *   GET  /api/v1/projects/:id/fs/history              → { undo: null, redo: null }
 *   GET  /api/v1/projects/:id/{trash,starred,recent}  → empty
 *   GET  /api/v1/projects/:id/pipeline-runs           → { runs: [] } (samples are never uploaded, so never run)
 *   GET  /api/v1/source-nodes/:id/{versions,activity,download}
 *   Every write (fs/ops, undo, star, zip, versions…) answers 501, like the rest.
 *   GET  /api/v1/features                             → every todo13 flag on (dev, §7.4)
 *   POST /api/v1/telemetry/timeline                   → 204 (accepted, not stored)
 */
interface SeedAsset {
  path: string;
  sha256?: string;
  bytes?: number;
  [k: string]: unknown;
}
interface SeedProject {
  id: string;
  title: string;
  status?: string;
  license?: string;
  restricted?: boolean;
  task?: string;
  environment?: { task?: string };
  assets?: SeedAsset[];
  [k: string]: unknown;
}

interface Node {
  id: string;
  sourceId: string;
  parentId: string | null;
  name: string;
  relPath: string;
  isDir: boolean;
  size: number | null;
  sha256: string | null;
  detectedKind: string | null;
  facts: Record<string, unknown>;
  sequenceKey: string | null;
  children: string[];
  descendants: number;
  assetPath?: string;
}

const PAGE = 500;
const MIN_SEQUENCE = 3;
const SEED_PRINCIPAL = "system:seed";
const ORG = "org-samples";
const FACT_KEYS = ["label", "subject", "sequence", "record", "fps", "frames", "duration", "width", "height", "mpp", "magnification", "role"];

// Same tables as apps/api/src/studio_api/kernel/kinds.py and overview.py.
const BY_EXTENSION: Record<string, string> = {
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image", ".tif": "image", ".tiff": "image",
  ".dcm": "dicom", ".nii": "volume", ".nii.gz": "volume", ".nrrd": "volume", ".mha": "volume",
  ".mp4": "video", ".webm": "video", ".avi": "video", ".hea": "waveform", ".dat": "waveform", ".edf": "waveform",
  ".svs": "slide", ".dzi": "slide", ".csv": "table", ".tsv": "table", ".xlsx": "table",
  ".pdf": "document", ".docx": "document", ".txt": "document", ".md": "document",
  ".zip": "archive", ".tar": "archive", ".tar.gz": "archive", ".gz": "archive",
};
const KIND_LABELS: Record<string, [string, string]> = {
  image: ["Image", "Images"], dicom: ["DICOM image", "DICOM images"], "dicom-series": ["DICOM series", "DICOM series"],
  volume: ["3D volume", "3D volumes"], video: ["Video", "Videos"], waveform: ["Waveform", "Waveforms"],
  slide: ["Whole-slide image", "Whole-slide images"], table: ["Table", "Tables"], document: ["Document", "Documents"],
  mask: ["Mask", "Masks"], annotations: ["Annotations", "Annotation files"], archive: ["Archive", "Archives"], unknown: ["Can't read yet", "Can't read yet"],
};

const extension = (name: string) => {
  const low = name.toLowerCase();
  for (const ext of [".nii.gz", ".tar.gz"]) if (low.endsWith(ext)) return ext;
  const dot = low.lastIndexOf(".");
  return dot > 0 ? low.slice(dot) : "";
};
const kindOf = (name: string) => {
  const kind = BY_EXTENSION[extension(name)] ?? "unknown";
  return kind === "volume" && /mask|seg/i.test(name) ? "mask" : kind;
};
export const nodeId = (sourceId: string, relPath: string) => "nod-" + crypto.createHash("sha256").update(`${sourceId}\x1f${relPath}`).digest("hex").slice(0, 20);
const sequenceKey = (name: string) => (/\d+(?=\D*$)/.test(name) ? name.replace(/\d+(?=\D*$)/, "#") : null);
/** The kernel's order (kernel/tree.py `natural_key`): `scan2` before `scan10`, case-insensitive, punctuation by code point. */
function naturalCompare(a: string, b: string): number {
  const parts = (s: string) => s.split(/(\d+)/).filter(Boolean).map((p) => (/^\d+$/.test(p) ? [1, "", Number(p)] : [0, p.toLowerCase(), 0]) as [number, string, number]);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const [t1, s1, n1] = x[i];
    const [t2, s2, n2] = y[i];
    if (t1 !== t2) return t1 - t2;
    if (s1 !== s2) return s1 < s2 ? -1 : 1;
    if (n1 !== n2) return n1 - n2;
  }
  return x.length - y.length;
}
const collator = { compare: naturalCompare };
const kindLabel = (kind: string | null, n: number) => (KIND_LABELS[kind ?? ""] ?? ["File", "Files"])[n === 1 ? 0 : 1];

interface Model {
  projects: SeedProject[];
  nodes: Map<string, Node>;
  roots: Map<string, string>;
  mtime: number;
}

export function projectStandIn(seedRoot: string, { resumeDir, annotationsDir }: { resumeDir: string; annotationsDir: string }) {
  const manifestFile = path.join(seedRoot, "manifest.json");
  let model: Model | null = null;

  function load(): Model {
    const mtime = fs.existsSync(manifestFile) ? fs.statSync(manifestFile).mtimeMs : 0;
    if (model && model.mtime === mtime) return model;
    const raw = mtime ? (JSON.parse(fs.readFileSync(manifestFile, "utf8")) as { projects: SeedProject[] }) : { projects: [] };
    const projects = raw.projects.filter((p) => (p.status ?? "available") === "available" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(p.id));
    const nodes = new Map<string, Node>();
    const roots = new Map<string, string>();
    for (const p of projects) {
      const entries = (p.assets ?? []).filter((a) => typeof a.path === "string" && !a.path.split("/").includes(".."));
      const tops = new Set(entries.filter((a) => a.path.includes("/")).map((a) => a.path.split("/")[0]));
      const shared = tops.size === 1 && entries.every((a) => a.path.includes("/"));
      const rootName = shared ? [...tops][0] : p.id;
      const rootId = nodeId(p.id, "");
      roots.set(p.id, rootId);
      nodes.set(rootId, { id: rootId, sourceId: p.id, parentId: null, name: rootName, relPath: "", isDir: true, size: null, sha256: null, detectedKind: "folder", facts: {}, sequenceKey: null, children: [], descendants: 0 });
      const dir = (rel: string): string => {
        const head = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
        if (!head) return rootId;
        const id = nodeId(p.id, head);
        if (!nodes.has(id)) {
          const parent = dir(head);
          nodes.set(id, { id, sourceId: p.id, parentId: parent, name: head.split("/").pop()!, relPath: head, isDir: true, size: null, sha256: null, detectedKind: "folder", facts: {}, sequenceKey: null, children: [], descendants: 0 });
          nodes.get(parent)!.children.push(id);
        }
        return id;
      };
      for (const a of entries) {
        const rel = shared ? a.path.slice(rootName.length + 1) : a.path;
        const name = rel.split("/").pop()!;
        const id = nodeId(p.id, rel);
        const parent = dir(rel);
        const facts: Record<string, unknown> = { source: "manifest" };
        for (const k of FACT_KEYS) if (a[k] !== undefined && a[k] !== null) facts[k] = a[k];
        nodes.set(id, { id, sourceId: p.id, parentId: parent, name, relPath: rel, isDir: false, size: typeof a.bytes === "number" ? a.bytes : null, sha256: a.sha256 ?? null, detectedKind: kindOf(rel), facts, sequenceKey: sequenceKey(name), children: [], descendants: 0, assetPath: a.path });
        nodes.get(parent)!.children.push(id);
        for (let up: string | null = parent; up; up = nodes.get(up)!.parentId) nodes.get(up)!.descendants += 1;
      }
    }
    model = { projects, nodes, roots, mtime };
    return model;
  }

  const project = (id: string) => load().projects.find((p) => p.id === id);
  const iso = (ms: number) => new Date(ms).toISOString();
  const createdAt = () => iso(load().mtime || Date.now());

  function resumeFile(projectId: string) {
    return path.join(resumeDir, `${projectId}.json`);
  }
  function readResume(projectId: string) {
    const f = resumeFile(projectId);
    return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as Record<string, unknown>) : null;
  }
  function annotationsOf(taskId: string): { annotations: { itemId?: string; provenance?: string; attributes?: Record<string, unknown> }[]; savedAt?: string } {
    const f = path.join(annotationsDir, `${taskId}.json`);
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : { annotations: [] };
  }

  function summary(p: SeedProject) {
    const resume = readResume(p.id);
    const saved = annotationsOf(p.id).savedAt;
    const times = [createdAt(), saved, resume?.at as string | undefined].filter(Boolean) as string[];
    return {
      id: p.id,
      orgId: ORG,
      title: p.title,
      description: "",
      visibility: "shared",
      sample: true,
      archived: false,
      createdBy: SEED_PRINCIPAL,
      createdAt: createdAt(),
      updatedAt: createdAt(),
      lastActivityAt: times.sort().at(-1),
      resume,
      attested: false,
      license: p.license,
      restricted: !!p.restricted,
    };
  }

  function nodeDict(n: Node, displayPath?: string) {
    return {
      id: n.id,
      sourceId: n.sourceId,
      parentId: n.parentId,
      name: n.name,
      ...(displayPath ? { displayPath } : {}),
      kind: n.isDir ? "folder" : "file",
      detectedKind: n.detectedKind,
      size: n.size,
      sha256: n.sha256,
      childCount: n.children.length,
      descendantCount: n.descendants,
      facts: n.facts,
      flags: {},
      status: "ready",
      importSessionId: null,
      createdAt: createdAt(),
      // todo7: sample data is locked (D2); files are as uploaded (version 1).
      locked: true,
      ...(n.isDir ? {} : { version: 1 }),
    };
  }

  const ordered = (ids: string[]) => {
    const { nodes } = load();
    return ids.map((id) => nodes.get(id)!).sort((a, b) => Number(a.isDir === false) - Number(b.isDir === false) || collator.compare(a.name, b.name));
  };

  function compact(n: Node): [Node, string | undefined] {
    const { nodes } = load();
    const names = [n.name];
    let cur = n;
    while (cur.children.length === 1 && nodes.get(cur.children[0])!.isDir) {
      cur = nodes.get(cur.children[0])!;
      names.push(cur.name);
    }
    return [cur, names.length > 1 ? names.join(" / ") : undefined];
  }

  // Opaque, like the kernel's (kernel/tree.py run_id): a run's key comes from file names.
  const runId = (folder: string, key: string) => `seq:${folder}:${crypto.createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
  const runOf = (n: Node) => {
    if (n.isDir || !n.sequenceKey || !n.parentId) return null;
    const count = (load().nodes.get(n.parentId)?.children ?? []).filter((id) => load().nodes.get(id)?.sequenceKey === n.sequenceKey).length;
    return count >= MIN_SEQUENCE ? runId(n.parentId, n.sequenceKey) : null;
  };

  function children(parent: string, cursor: number, size = PAGE) {
    const { nodes } = load();
    let items: unknown[];
    if (parent.startsWith("seq:")) {
      const folder = parent.split(":")[1];
      items = ordered(nodes.get(folder)?.children ?? []).filter((n) => !n.isDir && n.sequenceKey && runId(folder, n.sequenceKey) === parent).map((n) => nodeDict(n));
    } else {
      const rows = ordered(nodes.get(parent)?.children ?? []);
      const runs = new Map<string, Node[]>();
      for (const n of rows) if (!n.isDir && n.sequenceKey) runs.set(n.sequenceKey, [...(runs.get(n.sequenceKey) ?? []), n]);
      const emitted = new Set<string>();
      items = [];
      for (const n of rows) {
        const key = n.isDir ? null : n.sequenceKey;
        if (key && runs.get(key)!.length >= MIN_SEQUENCE) {
          if (emitted.has(key)) continue;
          emitted.add(key);
          const members = runs.get(key)!;
          const kinds = new Set(members.map((m) => m.detectedKind));
          items.push({ ...nodeDict(members[0]), id: runId(parent, key), kind: "sequence", name: `${members[0].name}–${members.at(-1)!.name}`, detectedKind: kinds.size === 1 ? [...kinds][0] : null, size: members.reduce((s, m) => s + (m.size ?? 0), 0), sha256: null, childCount: members.length, descendantCount: members.length, facts: {} });
        } else if (n.isDir) {
          const [deepest, display] = compact(n);
          items.push(nodeDict(deepest, display));
        } else items.push(nodeDict(n));
      }
    }
    const page = items.slice(cursor, cursor + size);
    return { items: page, total: items.length, nextCursor: cursor + size < items.length ? String(cursor + size) : null };
  }

  // ---- The drive (todo7 D1 / D12): one synthetic "Files" root per project over its sample folder.
  const driveRoot = (projectId: string) => "nod-" + crypto.createHash("sha256").update(`${projectId}\x1fdrive`).digest("hex").slice(0, 20);
  const isDriveRoot = (id: string) => load().projects.some((p) => driveRoot(p.id) === id);

  type Row = ReturnType<typeof nodeDict> & { kind: string; childCount: number; size: number | null };
  function sortRows(items: Row[], by: string, dir: string): Row[] {
    const sign = dir === "desc" ? -1 : 1;
    const key = (r: Row): number | string => (by === "size" ? (r.size ?? -1) : by === "kind" ? String(r.detectedKind ?? "") : by === "added" ? String(r.createdAt ?? "") : "");
    // Folders first always; then the key; then the name (natural).
    return items
      .map((r, i) => ({ r, i }))
      .sort((a, b) => {
        const fa = a.r.kind === "folder" ? 0 : 1;
        const fb = b.r.kind === "folder" ? 0 : 1;
        if (fa !== fb) return fa - fb;
        const ka = key(a.r);
        const kb = key(b.r);
        if (ka !== kb) return sign * (typeof ka === "number" && typeof kb === "number" ? ka - kb : String(ka) < String(kb) ? -1 : 1);
        return sign * (collator.compare(a.r.name, b.r.name) || a.i - b.i);
      })
      .map((x) => x.r);
  }

  function fsChildren(p: SeedProject, node: string, cursor: number, limit: number, by: string, dir: string) {
    const { nodes, roots } = load();
    const root = driveRoot(p.id);
    let items: Row[];
    if (node === root) {
      const [deepest, display] = compact(nodes.get(roots.get(p.id)!)!);
      items = [{ ...nodeDict(deepest, display), parentId: deepest.parentId ?? root } as Row];
    } else {
      items = children(node, 0, Number.MAX_SAFE_INTEGER).items as Row[];
      items = items.map((r) => (r.parentId === null ? { ...r, parentId: root } : r));
    }
    if (by !== "name" || dir !== "asc") items = sortRows(items, by, dir);
    const page = items.slice(cursor, cursor + limit);
    return { items: page, total: items.length, nextCursor: cursor + limit < items.length ? String(cursor + limit) : null };
  }

  function ancestors(n: Node) {
    const { nodes } = load();
    const out: Node[] = [];
    for (let up = n.parentId; up; up = nodes.get(up)!.parentId) out.unshift(nodes.get(up)!);
    return out;
  }

  function dataCards(p: SeedProject) {
    const { nodes, roots } = load();
    const byKind = new Map<string, string[]>();
    for (const n of nodes.values()) if (n.sourceId === p.id && !n.isDir && n.detectedKind) byKind.set(n.detectedKind, [...(byKind.get(n.detectedKind) ?? []), n.parentId!]);
    return [...byKind.entries()]
      .map(([kind, parents]) => {
        const folder = new Set(parents).size === 1 ? parents[0] : roots.get(p.id)!;
        const node = nodes.get(folder)!;
        return { type: "source", id: `${p.id}:${kind}`, title: node.parentId ? node.name : nodes.get(roots.get(p.id)!)!.name, count: parents.length, kind, kindLabel: kindLabel(kind, parents.length), sourceId: p.id, nodeId: folder };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 4);
  }

  /**
   * The task document's assets with their node and current folder below the task's common
   * folder (todo8 D3), like the kernel's `add_folders`: the sample folder is the common one.
   */
  function documentAssets(p: SeedProject) {
    const { nodes } = load();
    const byAsset = new Map<string, Node>();
    for (const n of nodes.values()) if (n.sourceId === p.id && n.assetPath) byAsset.set(n.assetPath, n);
    const folderOf = (n: Node) => ancestors(n).map((a) => a.name);
    const folders = (p.assets ?? []).map((a) => {
      const n = typeof a.path === "string" ? byAsset.get(a.path) : undefined;
      return n ? folderOf(n) : null;
    });
    const known = folders.filter((f): f is string[] => !!f);
    let common = known[0] ?? [];
    for (const f of known) {
      let k = 0;
      while (k < common.length && k < f.length && common[k] === f[k]) k++;
      common = common.slice(0, k);
    }
    return (p.assets ?? []).map((a, i) => {
      const n = typeof a.path === "string" ? byAsset.get(a.path) : undefined;
      return n ? { ...a, nodeId: n.id, folder: folders[i]!.slice(common.length) } : a;
    });
  }

  function task(p: SeedProject) {
    const doc = annotationsOf(p.id);
    return { id: p.id, datasetId: p.id, projectId: p.id, title: p.title, kind: String(p.task ?? p.environment?.task ?? "annotate"), revision: 0, annotationCount: doc.annotations.length, annotatedItems: new Set(doc.annotations.map((a) => a.itemId)).size, createdAt: createdAt() };
  }

  function dataset(p: SeedProject) {
    const { nodes, roots } = load();
    const files = [...nodes.values()].filter((n) => n.sourceId === p.id && !n.isDir).length;
    return { id: p.id, projectId: p.id, title: p.title, description: "", definition: { nodeIds: [roots.get(p.id)], seed: true }, fileCount: files, tasks: [task(p)], createdFromProposalId: null, createdBy: SEED_PRINCIPAL, createdAt: createdAt() };
  }

  /**
   * `GET …/datasets/:d/profile` (kernel/dataset_profile.py), from the manifest: one collection per
   * kind, formats from extensions, the size, rate and slide facts the manifest carries. Seeds are
   * vetted, so there are no issues and no relationship proposals.
   */
  function profile(p: SeedProject) {
    const { nodes } = load();
    const files = [...nodes.values()].filter((n) => n.sourceId === p.id && !n.isDir);
    const groups = new Map<string, Node[]>();
    for (const n of files) groups.set(n.detectedKind ?? "unknown", [...(groups.get(n.detectedKind ?? "unknown") ?? []), n]);
    const NAMES: Record<string, [string, string, string]> = {
      image: ["Images", "image", "images"], dicom: ["DICOM images", "image", "images"], volume: ["3D volumes", "volume", "volumes"], mask: ["Masks", "mask", "masks"],
      video: ["Videos", "video", "videos"], waveform: ["Waveforms", "recording", "recordings"], slide: ["Whole-slide images", "slide", "slides"], table: ["Tables", "table", "tables"],
      document: ["Documents", "document", "documents"], archive: ["Archives", "archive", "archives"], unknown: ["Files we can't read yet", "file", "files"],
    };
    const ORDER = ["dicom", "volume", "image", "video", "slide", "waveform", "mask", "table", "document", "archive", "unknown"];
    const rank = (kind: string) => (ORDER.includes(kind) ? ORDER.indexOf(kind) : ORDER.length);
    const tally = (values: (string | null)[]) => {
      const c = new Map<string, number>();
      for (const v of values) if (v) c.set(v, (c.get(v) ?? 0) + 1);
      const ranked = [...c.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      return { values: ranked.slice(0, 6).map(([value, count]) => ({ value, count })), more: Math.max(0, ranked.length - 6), missing: values.filter((v) => !v).length };
    };
    const num = (v: unknown) => (typeof v === "number" ? v : null);
    const collections = [...groups.entries()]
      .sort((a, b) => rank(a[0]) - rank(b[0]))
      .map(([kind, ns]) => {
        const [name, one, other] = NAMES[kind] ?? NAMES.unknown;
        const facts: { key: string; label: string; values: { value: string; count: number }[]; more: number; missing: number }[] = [];
        const add = (key: string, label: string, values: (string | null)[]) => {
          if (values.some(Boolean)) facts.push({ key, label, ...tally(values) });
        };
        add("size", kind === "video" ? "Frame size" : "Image size", ns.map((n) => (num(n.facts.width) && num(n.facts.height) ? `${n.facts.width} × ${n.facts.height} px` : null)));
        add("fps", "Frame rate", ns.map((n) => (num(n.facts.fps) ? `${n.facts.fps} fps` : null)));
        add("mpp", "Microns per pixel", ns.map((n) => (num(n.facts.mpp) ? String(n.facts.mpp) : null)));
        add("magnification", "Magnification", ns.map((n) => (num(n.facts.magnification) ? `${n.facts.magnification}×` : null)));
        const durations = ns.map((n) => num(n.facts.duration)).filter((d): d is number => d !== null);
        if (durations.length) {
          const s = (v: number) => (v < 60 ? `${Math.round(v * 10) / 10} s` : `${Math.floor(v / 60)} min ${String(Math.round(v % 60)).padStart(2, "0")} s`);
          const [lo, hi] = [Math.min(...durations), Math.max(...durations)];
          facts.push({ key: "duration", label: "Duration", values: [{ value: lo === hi ? s(lo) : `${s(lo)} – ${s(hi)}`, count: durations.length }], more: 0, missing: ns.length - durations.length });
        }
        const UNITS: Record<string, [string, string?]> = { size: ["text", "px"], fps: ["decimal", "fps"], mpp: ["decimal", "µm/px"], magnification: ["decimal", "×"], duration: ["decimal", "s"] };
        const fields = facts.map((f) => ({ id: `fact:${f.key}`, name: f.label, type: UNITS[f.key][0], ...(UNITS[f.key][1] ? { unit: UNITS[f.key][1] } : {}), required: f.missing === 0, filled: (ns.length - f.missing) / ns.length, source: "inspection" }));
        const formats = tally(ns.map((n) => extension(n.name).replace(/^\./, "").toUpperCase() || null));
        return { id: `kind:${kind}`, name, kind, count: ns.length, unit: { one, other }, files: ns.length, formats: formats.values.map((v) => ({ label: v.value, count: v.count })), facts, fields, previewNodeId: ns[0]?.id ?? null, suggested: true, issues: 0 };
      });
    return { datasetId: p.id, snapshot: { kind: "draft", label: "Working draft", readOnly: false }, files: files.length, checking: 0, collections, relationships: [], issues: [] };
  }

  /** `GET …/dataset-summaries` (kernel/datasets_views.py `summary`), from the profile above. */
  function landingSummary(p: SeedProject) {
    const prof = profile(p);
    return {
      datasetId: p.id,
      files: prof.files,
      checking: 0,
      collections: prof.collections.slice(0, 8).map(({ id, name, kind, count, unit, files, suggested, issues, previewNodeId }) => ({ id, name, kind, count, unit, files, suggested, issues, previewNodeId })),
      moreCollections: Math.max(0, prof.collections.length - 8),
      relationships: 0,
      issues: { count: 0, items: 0, blocking: 0, high: 0 },
      suggestions: prof.collections.filter((c) => c.suggested).length,
      snapshot: prof.snapshot,
      lastChangedAt: createdAt(),
    };
  }

  /** `GET …/dataset-attention`: a vetted sample has no problems; its inferred collections wait for a person to confirm them. */
  function datasetAttention(p: SeedProject) {
    const pending = profile(p).collections.filter((c) => c.suggested);
    if (!pending.length) return { items: [], total: 0, byKind: {} };
    const n = pending.length;
    const item = {
      id: `${p.id}:structure.suggested@1`,
      kind: "suggestion",
      datasetId: p.id,
      datasetTitle: p.title,
      severity: "low",
      blocking: false,
      title: `${n} suggested ${n === 1 ? "collection" : "collections"} to confirm`,
      detail: `${pending.map((c) => c.name).slice(0, 3).join(", ")}: inferred from the files. Nothing relies on ${n === 1 ? "it" : "them"} until someone confirms.`,
      count: n,
      action: { label: "Review structure", target: { section: "datasets", datasetId: p.id, tab: "structure" } },
      at: null,
    };
    return { items: [item], total: 1, byKind: { suggestion: 1 } };
  }

  function review(p: SeedProject) {
    const pending = annotationsOf(p.id).annotations.filter((a) => (a.provenance === "ai-suggested" || a.provenance === "imported") && (a.attributes?.review_status ?? "pending") === "pending");
    return pending.length ? [{ id: `annotations:${p.id}`, type: "annotations", severity: "low", title: `${pending.length} ${pending.length === 1 ? "annotation" : "annotations"} to review`, detail: p.title, target: { section: "studio", taskId: p.id }, datasetId: p.id, at: annotationsOf(p.id).savedAt ?? null }] : [];
  }

  function resumeDict(p: SeedProject, body: Record<string, unknown>) {
    return { taskId: p.id, taskTitle: p.title, taskKind: task(p).kind, datasetId: p.id, itemId: body.itemId ?? null, placement: body.placement && typeof body.placement === "object" ? body.placement : null, tool: body.tool ?? null, at: new Date().toISOString() };
  }

  return async function handle(req: IncomingMessage, res: ServerResponse, next: () => void) {
    const url = new URL(req.url ?? "/", "http://dev");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const send = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    };
    const notFound = () => send(404, { detail: "Not Found" });
    const [head, id, sub, subId, subSub] = parts;
    const { nodes } = load();

    if (head === "projects" && id && sub === "resume" && req.method === "PUT") {
      const p = project(id);
      if (!p) return notFound();
      const body = await readJson(req);
      if (body?.taskId !== p.id) return send(422, { detail: "taskId must name a task of this project" });
      const saved = resumeDict(p, body);
      fs.mkdirSync(resumeDir, { recursive: true });
      fs.writeFileSync(resumeFile(p.id), JSON.stringify(saved));
      return send(200, { resume: saved });
    }
    // todo13 §7.1: dev runs with every flag on (the api's development default); the timeline
    // post is accepted and dropped (the api logs it).
    if (head === "features" && !id && req.method === "GET") return send(200, { chatDrops: true, autoApply: true, fastPath: true, datasetsTab: true });
    if (head === "telemetry" && id === "timeline" && req.method === "POST") {
      res.statusCode = 204;
      return res.end();
    }
    if (req.method !== "GET" && req.method !== "HEAD") return send(501, { error: "needs the API", detail: "Adding data needs the full stack: see docs/running.md" });

    // Explore reads proposals, which only the inspection worker makes: the UI says it needs the full stack.
    if (head === "projects" && id && sub === "explore") return send(501, { error: "needs the API", detail: "Explore needs the full stack: see docs/running.md" });

    if (head === "projects") {
      if (!id) {
        const q = url.searchParams.get("q")?.toLowerCase();
        const list = load().projects.map(summary).filter((p) => !q || p.title.toLowerCase().includes(q));
        list.sort((a, b) => (url.searchParams.get("sort") === "title" ? a.title.localeCompare(b.title) : String(b.lastActivityAt).localeCompare(String(a.lastActivityAt))));
        return send(200, { projects: list });
      }
      const p = project(id);
      if (!p) return notFound();
      if (!sub) return send(200, summary(p));
      if (sub === "overview") {
        const s = summary(p);
        const cards = dataCards(p);
        const queue = review(p);
        return send(200, { project: s, ...(s.resume ? { resume: s.resume } : {}), tasks: [{ id: p.id, title: p.title, kind: task(p).kind, datasetId: p.id }], ...(cards.length ? { data: cards } : {}), ...(queue.length ? { attention: queue.slice(0, 5), attentionTotal: queue.length } : {}), empty: cards.length === 0 });
      }
      if (sub === "sources") {
        const root = load().roots.get(p.id)!;
        return send(200, { sources: [{ id: p.id, projectId: p.id, title: nodes.get(root)!.name, kind: "seed", status: "ready", rootNodeId: root, fileCount: nodes.get(root)!.descendants, createdBy: SEED_PRINCIPAL, createdAt: createdAt(), usedInDatasets: [p.id] }] });
      }
      if (sub === "datasets" && subId === p.id && subSub === "update-versions" && parts[5] === "preview") return send(200, { files: [] });
      if (sub === "dataset-summaries") return send(200, { datasets: [landingSummary(p)] });
      if (sub === "dataset-attention") {
        const only = url.searchParams.get("datasetId");
        if (only && only !== p.id) return notFound();
        return send(200, datasetAttention(p));
      }
      if (sub === "datasets") {
        if (!subId) return send(200, { datasets: [dataset(p)] });
        if (subId !== p.id) return notFound();
        if (subSub === "profile") return send(200, profile(p));
        return subSub === "tasks" ? send(200, { tasks: [task(p)] }) : send(200, dataset(p));
      }
      if (sub === "search") {
        const q = (url.searchParams.get("q") ?? "").toLowerCase();
        const kind = url.searchParams.get("kind");
        const status = url.searchParams.get("status");
        const items = status && status !== "ready" ? [] : [...nodes.values()].filter((n) => n.sourceId === p.id && n.parentId && (!q || n.name.toLowerCase().includes(q)) && (!kind || n.detectedKind === kind)).slice(0, 200);
        return send(200, { items: items.sort((a, b) => collator.compare(a.name, b.name)).map((n) => ({ ...nodeDict(n), folderPath: n.relPath.split("/").slice(0, -1).join("/") })) });
      }
      if (sub === "imports") return send(200, { imports: [] });
      if (sub === "pipeline-runs") return send(200, { runs: [], next_cursor: null });
      if (sub === "proposals") return send(200, { proposals: [] });
      if (sub === "review") {
        // Same shape and filters as the kernel's queue (seeds only ever have annotation rows).
        const all = review(p);
        const f = (k: string) => url.searchParams.get(k);
        const items = all.filter((i) => (!f("type") || i.type === f("type")) && (!f("severity") || i.severity === f("severity")) && (!f("dataset") || i.datasetId === f("dataset")));
        const count = (key: (i: (typeof all)[number]) => string) => all.reduce<Record<string, number>>((m, i) => ({ ...m, [key(i)]: (m[key(i)] ?? 0) + 1 }), {});
        return send(200, { items, total: all.length, facets: { types: count((i) => i.type), severities: count((i) => i.severity), datasets: all.length ? [{ id: p.id, title: p.title, count: all.length }] : [] } });
      }
      if (sub === "activity") {
        // Read-only: the one thing that happened to a sample is that it was loaded.
        const at = createdAt();
        const entries = url.searchParams.get("cursor") ? [] : [{ id: `seed:${p.id}`, action: "project.created", label: "added the sample", actor: SEED_PRINCIPAL, onBehalfOf: null, who: { kind: "system", name: "Sample data", onBehalfOf: null }, target: p.id, subject: p.title, details: {}, at, link: { section: "sources" } }];
        return send(200, { entries, nextCursor: null });
      }
      if (sub === "fs") {
        // todo7 D12: the drive, read-only (writes fall through to the 501 above).
        if (!subId) return send(200, { projectId: p.id, rootNodeId: driveRoot(p.id), writable: false, trashCount: 0 });
        if (subId === "children") {
          const node = url.searchParams.get("node") || driveRoot(p.id);
          if (node !== driveRoot(p.id) && !node.startsWith("seq:") && nodes.get(node)?.sourceId !== p.id) return send(404, { detail: "no such folder in this project" });
          const limit = Math.max(1, Math.min(PAGE, Number(url.searchParams.get("limit") ?? PAGE) || PAGE));
          const by = url.searchParams.get("sort") ?? "name";
          const dir = url.searchParams.get("dir") ?? "asc";
          return send(200, fsChildren(p, node, Number(url.searchParams.get("cursor") ?? 0) || 0, limit, by, dir));
        }
        if (subId === "history") return send(200, { undo: null, redo: null });
        return notFound();
      }
      if (sub === "trash") {
        if (subId === "empty" && subSub === "preview") return send(200, { purged: 0, keptBytes: [] });
        return subId ? notFound() : send(200, { items: [], nextCursor: null, total: 0 });
      }
      // Stars fall back to localStorage in the UI (docs/files-api.md); recent needs the journal.
      if (sub === "starred" || sub === "recent") return send(200, { items: [] });
      if (sub === "resume") return send(200, { resume: readResume(p.id) });
      if (sub === "events") {
        // No live updates without the kernel: an idle stream the browser can keep open.
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.write("retry: 30000\n\n");
        const t = setInterval(() => res.write(": keep-alive\n\n"), 15000);
        req.on("close", () => clearInterval(t));
        return;
      }
      return notFound();
    }
    // No structure drafts without the kernel (todo13-organize stores them in versioning).
    if (head === "datasets" && id && sub === "structure") return notFound();
    if (head === "sources" && id && sub === "children") {
      const p = project(id);
      if (!p) return notFound();
      const node = url.searchParams.get("node") ?? load().roots.get(p.id)!;
      if (!node.startsWith("seq:") && nodes.get(node)?.sourceId !== p.id) return send(404, { detail: "no such folder in this source" });
      return send(200, children(node, Number(url.searchParams.get("cursor") ?? 0) || 0));
    }
    if (head === "source-nodes" && id && isDriveRoot(id)) {
      const p = load().projects.find((x) => driveRoot(x.id) === id)!;
      if (sub === "versions") return send(200, { versions: [] });
      if (sub === "activity") return send(200, { items: [] });
      if (sub) return notFound();
      const files = nodes.get(load().roots.get(p.id)!)!.descendants;
      return send(200, { id, sourceId: p.id, parentId: null, name: "Files", kind: "folder", detectedKind: "folder", size: null, sha256: null, childCount: 1, descendantCount: files, facts: {}, flags: {}, status: "ready", importSessionId: null, createdAt: createdAt(), locked: true, path: [], usedIn: [], runId: null, pathText: "", provenance: { sourceId: p.id, sourceTitle: null, importSessionId: null, addedBy: SEED_PRINCIPAL, addedAt: createdAt(), sha256: null } });
    }
    if (head === "source-nodes" && id) {
      const n = nodes.get(id);
      if (!n) return send(404, { detail: "no such file or folder" });
      const p = project(n.sourceId)!;
      if (sub === "preview") {
        const out: Record<string, unknown> = { nodeId: n.id, kind: n.isDir ? "folder" : n.detectedKind, facts: n.facts };
        if (n.assetPath && (n.detectedKind === "image" || n.detectedKind === "mask")) out.url = `/seed/${n.assetPath}`;
        return send(200, out);
      }
      if (sub === "versions") return send(200, { versions: n.isDir ? [] : [{ version: 1, assetId: n.assetPath ?? n.id, sha256: n.sha256, size: n.size, createdBy: SEED_PRINCIPAL, createdAt: createdAt(), current: true }] });
      if (sub === "activity") return send(200, { items: [] });
      if (sub === "download") {
        if (n.isDir || !n.assetPath) return send(501, { error: "needs the API", detail: "Downloading folders needs the full stack: see docs/running.md" });
        res.statusCode = 302;
        res.setHeader("Location", `/seed/${n.assetPath.split("/").map(encodeURIComponent).join("/")}`);
        return res.end();
      }
      const tasks = [{ id: p.id, title: p.title }];
      return send(200, { ...nodeDict(n), path: ancestors(n).map((a) => ({ id: a.id, name: a.name })), usedIn: [{ id: p.id, title: p.title, tasks }], runId: runOf(n), provenance: { sourceId: p.id, sourceTitle: nodes.get(load().roots.get(p.id)!)!.name, importSessionId: null, addedBy: SEED_PRINCIPAL, addedAt: createdAt(), sha256: n.sha256 } });
    }
    if (head === "tasks" && id) {
      const p = project(id);
      if (!p) return send(404, { detail: "no such task" });
      if (!sub) return send(200, task(p));
      // The Studio normalizes manifest projects itself (lib/api.ts normalizeProject).
      if (sub === "document") return send(200, { ...p, status: "available", assets: documentAssets(p) });
      return notFound();
    }
    return next();
  };
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : undefined);
      } catch {
        resolve(undefined);
      }
    });
  });
}
