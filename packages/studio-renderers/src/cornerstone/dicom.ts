import { imageLoader, metaData, utilities as csUtils } from "@cornerstonejs/core";
import { absoluteUrl, ensureDicom } from "./init";
import { NS } from "@studio/plugin-contracts/naming";
import { assetUrl } from "@studio/plugin-ui-sdk";

export const isDicomPath = (p: string) => /\.dcm$/i.test(p);

export function wadouriId(path: string): string {
  return `wadouri:${absoluteUrl(assetUrl(path))}`;
}

/**
 * Load every file of a DICOM series (pixel data + metadata) and return the image ids in
 * Cornerstone's own slice order (sortImageIdsAndGetSpacing, as the volume loader uses),
 * so voxel k of a volume and frame k of an exported SEG refer to the same instance.
 */
export async function loadDicomSeries(paths: string[]): Promise<string[]> {
  await ensureDicom();
  const ids = paths.map(wadouriId);
  await Promise.all(ids.map((id) => imageLoader.loadAndCacheImage(id)));
  ids.forEach(patchPlaneGeometry);
  if (ids.length < 2) return ids;
  return csUtils.sortImageIdsAndGetSpacing(ids).sortedImageIds;
}

export function modalityOf(imageId: string): string | undefined {
  return metaData.get("generalSeriesModule", imageId)?.modality;
}

/** Physical pixel spacing (mm) when the image declares one. */
export function pixelSpacingOf(imageId: string): [number, number] | null {
  const plane = metaData.get("imagePlaneModule", imageId);
  const r = plane?.rowPixelSpacing, c = plane?.columnPixelSpacing;
  return r && c ? [r, c] : null;
}

const planeOverrides = new Map<string, Record<string, unknown>>();
let overrideProvider = false;

/**
 * Projection radiographs (DX/CR/MG) carry no ImagePositionPatient / ImageOrientationPatient.
 * Cornerstone's viewport assumes an identity plane at the origin for them, but its
 * image↔world utilities (and the SR adapter) read the metadata and fail. Give such images
 * that same identity geometry explicitly, ahead of the DICOM provider.
 */
export function patchPlaneGeometry(imageId: string) {
  const plane = metaData.get("imagePlaneModule", imageId) as Record<string, unknown> | undefined;
  if (!plane || (plane.imagePositionPatient && plane.rowCosines && plane.columnCosines)) return;
  const fix = {
    ...plane,
    imagePositionPatient: plane.imagePositionPatient ?? [0, 0, 0],
    imageOrientationPatient: plane.imageOrientationPatient ?? [1, 0, 0, 0, 1, 0],
    rowCosines: plane.rowCosines ?? [1, 0, 0],
    columnCosines: plane.columnCosines ?? [0, 1, 0],
    frameOfReferenceUID: plane.frameOfReferenceUID ?? `${NS}.dx.${imageId}`,
  };
  planeOverrides.set(imageId, fix);
  if (!overrideProvider) {
    overrideProvider = true;
    metaData.addProvider((type: string, id: string) => (type === "imagePlaneModule" ? planeOverrides.get(id) : undefined), 10_000);
  }
}
