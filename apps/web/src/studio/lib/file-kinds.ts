import {
  AnnotationFileIcon,
  ArchiveFileIcon,
  DocumentIcon,
  FileSequenceIcon,
  FolderIcon,
  FolderOpenIcon,
  ImageIcon,
  MaskFileIcon,
  SlideIcon,
  TableFileIcon,
  UnknownFileIcon,
  VideoIcon,
  VolumeIcon,
  WaveformIcon,
  type IconComponent,
} from "@studio/ui/icons";
import type { DetectedKind, SourceNode, StudioItem } from "@studio/contracts/types";

/**
 * File kinds as the UI shows them (todo6 §3 "File kinds"). The worker detects kinds from file
 * content; the client only displays them. Rows not inspected yet fall back to the extension,
 * marked "Checking…". Icons are monochrome; colour never carries meaning on its own.
 */
interface KindView {
  label: string;
  plural: string;
  icon: IconComponent;
}

export const KINDS: Record<DetectedKind, KindView> = {
  folder: { label: "Folder", plural: "Folders", icon: FolderIcon },
  image: { label: "Image", plural: "Images", icon: ImageIcon },
  dicom: { label: "DICOM image", plural: "DICOM images", icon: ImageIcon },
  "dicom-series": { label: "DICOM series", plural: "DICOM series", icon: VolumeIcon },
  volume: { label: "3D volume", plural: "3D volumes", icon: VolumeIcon },
  video: { label: "Video", plural: "Videos", icon: VideoIcon },
  waveform: { label: "Waveform", plural: "Waveforms", icon: WaveformIcon },
  slide: { label: "Whole-slide image", plural: "Whole-slide images", icon: SlideIcon },
  table: { label: "Table", plural: "Tables", icon: TableFileIcon },
  document: { label: "Document", plural: "Documents", icon: DocumentIcon },
  mask: { label: "Mask", plural: "Masks", icon: MaskFileIcon },
  annotations: { label: "Annotations", plural: "Annotation files", icon: AnnotationFileIcon },
  archive: { label: "Archive", plural: "Archives", icon: ArchiveFileIcon },
  unknown: { label: "We can't read this file yet", plural: "Files we can't read yet", icon: UnknownFileIcon },
};

// Same table as the kernel's kinds.py, for rows the worker hasn't inspected yet.
const BY_EXTENSION: Record<string, DetectedKind> = {
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image", ".tif": "image", ".tiff": "image",
  ".dcm": "dicom", ".nii": "volume", ".nii.gz": "volume", ".nrrd": "volume", ".mha": "volume",
  ".mp4": "video", ".webm": "video", ".avi": "video", ".hea": "waveform", ".dat": "waveform", ".edf": "waveform",
  ".svs": "slide", ".dzi": "slide", ".csv": "table", ".tsv": "table", ".xlsx": "table",
  ".pdf": "document", ".docx": "document", ".txt": "document", ".md": "document",
  ".zip": "archive", ".tar": "archive", ".tar.gz": "archive", ".gz": "archive",
};

export function extensionOf(name: string): string {
  const low = name.toLowerCase();
  for (const ext of [".nii.gz", ".tar.gz"]) if (low.endsWith(ext)) return ext;
  const dot = low.lastIndexOf(".");
  return dot > 0 ? low.slice(dot) : "";
}

export function guessKind(name: string): DetectedKind {
  return BY_EXTENSION[extensionOf(name)] ?? "unknown";
}

export function kindIcon(kind: DetectedKind | string | null | undefined): IconComponent {
  return KINDS[kind as DetectedKind]?.icon ?? UnknownFileIcon;
}

/** The kind a row shows: detected, else (while checking) the extension's guess. */
export function nodeKind(n: Pick<SourceNode, "kind" | "detectedKind" | "name">): DetectedKind {
  if (n.kind === "folder") return "folder";
  return n.detectedKind ?? guessKind(n.name);
}

export function nodeIcon(n: Pick<SourceNode, "kind" | "detectedKind" | "name">, open = false): IconComponent {
  if (n.kind === "sequence") return FileSequenceIcon;
  if (n.kind === "folder") return open ? FolderOpenIcon : FolderIcon;
  return kindIcon(nodeKind(n));
}

/** "MRI series · 120", "Table", "Folder · 12": plain words, counts for folders and runs. */
export function kindLabel(n: Pick<SourceNode, "kind" | "detectedKind" | "name" | "childCount" | "descendantCount" | "facts">): string {
  if (n.kind === "folder") return `Folder · ${n.descendantCount.toLocaleString()} ${n.descendantCount === 1 ? "file" : "files"}`;
  const kind = nodeKind(n);
  // Not inspected yet and no extension we know: say nothing we don't know.
  if (!n.detectedKind && kind === "unknown" && n.kind === "file") return "File";
  const modality = typeof n.facts?.modality === "string" ? `${n.facts.modality} ` : "";
  if (n.kind === "sequence") return `${modality}${KINDS[kind]?.plural ?? "Files"} · ${n.childCount.toLocaleString()}`;
  if (kind === "dicom-series" && modality) return `${modality.trim()} series`;
  return KINDS[kind]?.label ?? "File";
}

/** Row status in plain words (todo6 §3 copy rules); the icon is chosen by the caller. */
export const STATUS_LABEL: Record<SourceNode["status"], string> = {
  checking: "Checking",
  ready: "Ready",
  attention: "Needs attention",
  privacy: "Held for privacy review",
  unsupported: "We can't read this file yet",
};

/** Why a row has its status, for the tooltip (never a patient identifier: flags are kernel-written). */
export function statusReason(n: Pick<SourceNode, "status" | "flags">): string | undefined {
  if (n.status === "privacy") return n.flags.privacy?.reason ? `Held: ${n.flags.privacy.reason}` : STATUS_LABEL.privacy;
  if (n.status === "attention") {
    if (n.flags.duplicate_of) return `Same file as ${n.flags.duplicate_of.name}`;
    if (n.flags.quality?.length) return n.flags.quality.join(" · ");
  }
  if (n.status === "unsupported") return n.flags.unsupported ?? STATUS_LABEL.unsupported;
  return n.status === "ready" ? undefined : STATUS_LABEL[n.status];
}

/**
 * The kind a Studio item shows in the Files tab: its main asset's (not a reference mask or a
 * thumbnail), a DICOM series when it holds several DICOM files. Null when the extension says
 * nothing (e.g. a seed's JSON waveform): the caller shows the data kind's own icon.
 */
export function itemKind(item: Pick<StudioItem, "assets">): DetectedKind | null {
  const main = item.assets.filter((a) => a.role !== "reference" && a.role !== "thumbnail");
  const first = main[0] ?? item.assets[0];
  if (!first) return null;
  const kind = guessKind(first.path);
  if (kind === "dicom" && main.filter((a) => guessKind(a.path) === "dicom").length > 1) return "dicom-series";
  return kind === "unknown" ? null : kind;
}
