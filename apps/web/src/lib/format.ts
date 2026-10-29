import { Activity, Brain, Film, HeartPulse, Image, Microscope, type LucideIcon } from "lucide-react";
import type { Project, ViewerKind } from "@/types";

export const VIEWER_META: Record<ViewerKind, { label: string; icon: LucideIcon }> = {
  "image-2d": { label: "2D image", icon: Image },
  "volume-3d": { label: "3D volume", icon: Brain },
  signal: { label: "Waveform", icon: Activity },
  temporal: { label: "Video", icon: Film },
  "cine-4d": { label: "4D cine", icon: HeartPulse },
  pathology: { label: "Whole-slide", icon: Microscope },
};

export function projectIcon(project: Project): LucideIcon {
  return VIEWER_META[project.viewer].icon;
}

/** Noun for the unit an expert works through in each data type. */
export const ITEM_NOUN: Record<ViewerKind, string> = {
  "image-2d": "image",
  "volume-3d": "subject",
  signal: "recording",
  temporal: "video",
  "cine-4d": "study",
  pathology: "slide",
};

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
