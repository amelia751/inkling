import type { ItemPart, Project, SeedAsset, StudioItem } from "@studio/contracts/types";
import { ns } from "@studio/contracts/naming";
import { assetName } from "@studio/plugin-ui-sdk/assets";

/**
 * The `volume` data kind: one item per subject, whose files (sequences, DICOM series,
 * reference segmentations) travel together. `volumeSources` splits a subject into the
 * volumes the renderer can show; the sequence picker is driven by it. Pure.
 */
export const VOLUME = ns("volume");
export const VOLUME_KIND = `${VOLUME}.dataKinds.volume`;

const isDicomPath = (p: string) => /\.dcm$/i.test(p);

/** Sequence / reference tokens recognised as a `<subject>_<sequence>` file-name suffix (BraTS-style). */
export const SEQUENCE_TOKENS = ["t1", "t1ce", "t1c", "t1gd", "t2", "flair", "t2f", "t2w", "t1w", "t1n", "pd", "dwi", "adc", "seg", "gt"];
const SUFFIX = new RegExp(`^(.+?)[_-](${SEQUENCE_TOKENS.join("|")})$`, "i");

const fileName = (a: Pick<SeedAsset, "path" | "name">) => assetName(a);
const stem = (name: string) => name.replace(/\.(nii\.gz|nii|dcm|gz)$/i, "");

/**
 * Subject and sequence of a file the kernel didn't tag (an upload, a dropped folder): a
 * `<subject>_<sequence>` stem gives both; a DICOM file is its folder's series; anything else
 * is its own subject. The folder path is part of the key, so same-named files in different
 * folders stay apart.
 */
export function inferSubject(a: Pick<SeedAsset, "path" | "name" | "subject" | "sequence" | "folder">): { subject: string; sequence?: string } {
  if (a.subject) return { subject: a.subject, sequence: a.sequence };
  const folder = Array.isArray(a.folder) ? a.folder : [];
  const s = stem(fileName(a));
  const m = SUFFIX.exec(s);
  if (m) return { subject: m[1], sequence: a.sequence ?? m[2].toLowerCase() };
  if (isDicomPath(fileName(a)) && folder.length) return { subject: folder[folder.length - 1], sequence: a.sequence };
  return { subject: s, sequence: a.sequence };
}

export function groupItems(project: Project): StudioItem[] {
  const bySubject = new Map<string, StudioItem>();
  for (const raw of project.assets) {
    const { subject, sequence } = inferSubject(raw);
    const asset = sequence && !raw.sequence ? { ...raw, sequence } : raw;
    const key = raw.subject ? subject : [...(Array.isArray(raw.folder) ? raw.folder : []), subject].join("/");
    const item = bySubject.get(key) ?? { id: key, name: subject, group: "Subjects", assets: [], dataKind: VOLUME_KIND };
    item.assets.push(asset);
    bySubject.set(key, item);
  }
  return [...bySubject.values()].map((item) => {
    const parts = itemParts(item.assets);
    return parts.length > 1 ? { ...item, parts } : item;
  });
}

/** The Items panel's rows under a subject: one per sequence / series, then the reference segmentation. */
export function itemParts(assets: SeedAsset[]): ItemPart[] {
  const parts: ItemPart[] = volumeSources(assets).map((s) => ({ key: s.key, label: s.label, role: "view" }));
  const ref = referenceAsset(assets);
  if (ref) parts.push({ key: REFERENCE_SEQUENCE, label: `${ref.sequence ?? REFERENCE_SEQUENCE} (reference)`, role: "reference" });
  return parts;
}

/** One displayable volume of a subject: a NIfTI sequence, or a whole DICOM series. */
export interface VolumeSource {
  key: string;
  label: string;
  kind: "nifti" | "dicom";
  paths: string[];
}

/** Sequence of a subject's reference (ground-truth) segmentation, shown read-only. */
export const REFERENCE_SEQUENCE = "seg";

/** BraTS `_seg` / `_gt` names are reference segmentations even when untagged (todo18 P1). */
export function isReferencePath(path: string): boolean {
  return /_(seg|gt)\.(nii\.gz|nii)$/i.test(path);
}

function isReference(a: Pick<SeedAsset, "path" | "sequence" | "name">): boolean {
  return a.sequence === REFERENCE_SEQUENCE || (!a.sequence && isReferencePath(a.path)) || ["seg", "gt"].includes(a.sequence?.toLowerCase() ?? "") || (!a.sequence && isReferencePath(a.name ?? ""));
}

export function volumeSources(assets: Pick<SeedAsset, "path" | "sequence" | "name">[]): VolumeSource[] {
  const groups = new Map<string, VolumeSource>();
  for (const a of assets) {
    if (isReference(a)) continue;
    const dicom = isDicomPath(a.path);
    const key = a.sequence ?? (dicom ? "series" : a.path);
    const g = groups.get(key) ?? { key, label: a.sequence ?? (dicom ? "Series" : fileName(a)), kind: dicom ? "dicom" : "nifti", paths: [] };
    g.paths.push(a.path);
    groups.set(key, g);
  }
  return [...groups.values()];
}

/** The source opened first: the preferred sequence when present, else the first. */
export function initialSource(sources: VolumeSource[], preferred?: string): VolumeSource | undefined {
  return sources.find((s) => s.key === preferred) ?? sources[0];
}

export function referenceAsset<A extends Pick<SeedAsset, "sequence" | "path" | "name">>(assets: A[]): A | undefined {
  return assets.find((a) => a.sequence === REFERENCE_SEQUENCE) ?? assets.find((a) => isReference(a));
}
