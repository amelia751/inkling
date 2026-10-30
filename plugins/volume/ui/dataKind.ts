import type { Project, SeedAsset, StudioItem } from "@studio/contracts/types";
import { ns } from "@studio/contracts/naming";

/**
 * The `volume` data kind: one item per subject, whose files (sequences, DICOM series,
 * reference segmentations) travel together. `volumeSources` splits a subject into the
 * volumes the renderer can show; the sequence picker is driven by it. Pure.
 */
export const VOLUME = ns("volume");
export const VOLUME_KIND = `${VOLUME}.dataKinds.volume`;

const isDicomPath = (p: string) => /\.dcm$/i.test(p);

export function groupItems(project: Project): StudioItem[] {
  const bySubject = new Map<string, StudioItem>();
  for (const asset of project.assets) {
    const subject = asset.subject ?? "subject";
    const item = bySubject.get(subject) ?? { id: subject, name: subject, group: "Subjects", assets: [], dataKind: VOLUME_KIND };
    item.assets.push(asset);
    bySubject.set(subject, item);
  }
  return [...bySubject.values()];
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

export function volumeSources(assets: Pick<SeedAsset, "path" | "sequence">[]): VolumeSource[] {
  const groups = new Map<string, VolumeSource>();
  for (const a of assets) {
    if (a.sequence === REFERENCE_SEQUENCE) continue;
    const dicom = isDicomPath(a.path);
    const key = a.sequence ?? (dicom ? "series" : a.path);
    const g = groups.get(key) ?? { key, label: a.sequence ?? (dicom ? "Series" : a.path.split("/").pop()!), kind: dicom ? "dicom" : "nifti", paths: [] };
    g.paths.push(a.path);
    groups.set(key, g);
  }
  return [...groups.values()];
}

/** The source opened first: the preferred sequence when present, else the first. */
export function initialSource(sources: VolumeSource[], preferred?: string): VolumeSource | undefined {
  return sources.find((s) => s.key === preferred) ?? sources[0];
}

export function referenceAsset<A extends Pick<SeedAsset, "sequence">>(assets: A[]): A | undefined {
  return assets.find((a) => a.sequence === REFERENCE_SEQUENCE);
}
