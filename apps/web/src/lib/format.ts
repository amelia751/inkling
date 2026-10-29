import { WaveformIcon, VolumeIcon, VideoIcon, CardiacIcon, ImageIcon, SlideIcon, type IconComponent } from "@/components/icons";
import type { Project, ViewerKind } from "@/types";

export const VIEWER_META: Record<ViewerKind, { label: string; icon: IconComponent }> = {
  "image-2d": { label: "2D image", icon: ImageIcon },
  "volume-3d": { label: "3D volume", icon: VolumeIcon },
  signal: { label: "Waveform", icon: WaveformIcon },
  temporal: { label: "Video", icon: VideoIcon },
  "cine-4d": { label: "4D cine", icon: CardiacIcon },
  pathology: { label: "Whole-slide", icon: SlideIcon },
};

export function projectIcon(project: Project): IconComponent {
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

export function pluralWord(n: number, word: string): string {
  if (n === 1) return word;
  return /[^aeiou]y$/.test(word) ? `${word.slice(0, -1)}ies` : `${word}s`;
}

export function plural(n: number, word: string): string {
  return `${n} ${pluralWord(n, word)}`;
}
