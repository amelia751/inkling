import { cache, volumeLoader, type Types } from "@cornerstonejs/core";
import { createNiftiImageIdsAndCacheMetadata } from "@cornerstonejs/nifti-volume-loader";
import { loadDicomSeries } from "@studio/renderers/cornerstone/dicom";
import { absoluteUrl } from "@studio/renderers/cornerstone/init";
import type { VolumeSource } from "../dataKind";
import { assetUrl } from "@studio/plugin-ui-sdk";

/** Volumes are loaded into Cornerstone's cache once per session (shared across mounts). */
const volumePromises = new Map<string, Promise<string>>();

type LoadableVolume = Types.IImageVolume & { loadStatus?: { loaded?: boolean } };

function cachedVolume(key: string, volumeId: string, imageIds: () => Promise<string[]>): Promise<string> {
  let p = volumePromises.get(key);
  if (!p) {
    p = (async () => {
      let vol = cache.getVolume(volumeId) as LoadableVolume | undefined;
      if (!vol) vol = (await volumeLoader.createAndCacheVolume(volumeId, { imageIds: await imageIds() })) as unknown as LoadableVolume;
      if (!vol.loadStatus?.loaded) {
        await new Promise<void>((resolve) => {
          vol!.load(() => resolve());
          if (vol!.loadStatus?.loaded) resolve();
        });
      }
      return volumeId;
    })();
    p.catch(() => volumePromises.delete(key));
    volumePromises.set(key, p);
  }
  return p;
}

/** A NIfTI file as one volume. */
function loadNiftiVolume(path: string): Promise<string> {
  return cachedVolume(path, `cornerstoneStreamingImageVolume:ink:${path}`, async () => {
    const imageIds = await createNiftiImageIdsAndCacheMetadata({ url: absoluteUrl(assetUrl(path)) });
    if (!imageIds?.length) throw new Error(`Could not read ${path}`);
    return imageIds;
  });
}

/** A DICOM series (wadouri) as one volume, in Cornerstone's slice order. */
function loadDicomVolume(paths: string[]): Promise<string> {
  const key = `dicom:${paths[0]}:${paths.length}`;
  return cachedVolume(key, `cornerstoneStreamingImageVolume:ink:${key}`, () => loadDicomSeries(paths));
}

export function loadSource(src: VolumeSource): Promise<string> {
  return src.kind === "dicom" ? loadDicomVolume(src.paths) : loadNiftiVolume(src.paths[0]);
}

export function scalarArray(volumeId: string): ArrayLike<number> {
  const vol = cache.getVolume(volumeId);
  return vol?.voxelManager?.getCompleteScalarDataArray?.() ?? [];
}
