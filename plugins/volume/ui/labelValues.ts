import { labelNames } from "@studio/plugin-contracts/environment";
import type { Project } from "@studio/plugin-contracts/types";

/**
 * Voxel values of label classes in exported labelmaps and reference segmentations.
 * BraTS convention (necrotic core 1, edema 2, enhancing tumor 4) for BraTS projects,
 * otherwise label index + 1. Pure.
 */
export function isBrats(project: Pick<Project, "id" | "title" | "source" | "labels">): boolean {
  return /brats/i.test(`${project.id} ${project.title} ${project.source}`) && labelNames(project.labels).length === 3;
}

const BRATS_VALUES = [1, 2, 4];

/** Voxel value written for a label (and read from a reference segmentation). */
export function labelValue(project: Pick<Project, "id" | "title" | "source" | "labels">, label: string): number {
  const i = labelNames(project.labels).indexOf(label);
  if (i < 0) return 0;
  return isBrats(project) ? BRATS_VALUES[i] : i + 1;
}

/** Label index for a voxel value of a reference segmentation, or -1. */
export function labelIndexForValue(project: Pick<Project, "id" | "title" | "source" | "labels">, value: number): number {
  if (!value) return -1;
  if (isBrats(project)) return BRATS_VALUES.indexOf(value);
  const i = value - 1;
  return i < labelNames(project.labels).length ? i : -1;
}
