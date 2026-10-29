import { utilities, type Types } from "@cornerstonejs/core";

/**
 * Image loader for plain web images (JPEG / PNG) so radiographs that ship as JPEG can be
 * shown in a Cornerstone StackViewport. Mirrors Cornerstone's `webImageLoader` example:
 * decode via the browser, keep one channel when the image is grayscale, and register the
 * metadata modules Cornerstone needs. No pixel spacing is known, so tools report pixels.
 *
 * imageId: `inkimg:<absolute url>`
 */
export const WEB_IMAGE_SCHEME = "inkimg";

export function webImageId(absoluteUrl: string): string {
  return `${WEB_IMAGE_SCHEME}:${absoluteUrl}`;
}

async function decode(url: string): Promise<{ width: number; height: number; rgba: Uint8ClampedArray }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not fetch image (${res.status})`);
  const bitmap = await createImageBitmap(await res.blob());
  const { width, height } = bitmap;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return { width, height, rgba: ctx.getImageData(0, 0, width, height).data };
}

function isGray(rgba: Uint8ClampedArray): boolean {
  const step = Math.max(4, Math.floor(rgba.length / 4 / 50_000) * 4);
  for (let i = 0; i < rgba.length; i += step) {
    if (Math.abs(rgba[i] - rgba[i + 1]) > 2 || Math.abs(rgba[i] - rgba[i + 2]) > 2) return false;
  }
  return true;
}

export function loadWebImage(imageId: string): Types.IImageLoadObject {
  const url = imageId.slice(WEB_IMAGE_SCHEME.length + 1);
  const promise = decode(url).then(({ width, height, rgba }) => {
    const gray = isGray(rgba);
    const components = gray ? 1 : 3;
    const pixels = new Uint8Array(width * height * components);
    let min = 255;
    let max = 0;
    for (let i = 0, o = 0; i < rgba.length; i += 4) {
      if (gray) {
        const v = rgba[i];
        pixels[o++] = v;
        if (v < min) min = v;
        if (v > max) max = v;
      } else {
        pixels[o++] = rgba[i];
        pixels[o++] = rgba[i + 1];
        pixels[o++] = rgba[i + 2];
      }
    }
    if (!gray) {
      min = 0;
      max = 255;
    }
    registerMetadata(imageId, width, height, gray);
    const voxelManager = utilities.VoxelManager.createImageVoxelManager({
      width,
      height,
      scalarData: pixels,
      numberOfComponents: components,
    });
    const image = {
      imageId,
      minPixelValue: min,
      maxPixelValue: max,
      slope: 1,
      intercept: 0,
      windowCenter: (max + min) / 2,
      windowWidth: Math.max(1, max - min),
      voiLUTFunction: "LINEAR",
      getPixelData: () => pixels,
      getCanvas: () => {
        const c = document.createElement("canvas");
        c.width = width;
        c.height = height;
        c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
        return c;
      },
      rows: height,
      columns: width,
      height,
      width,
      color: !gray,
      rgba: false,
      numberOfComponents: components,
      columnPixelSpacing: 1,
      rowPixelSpacing: 1,
      invert: false,
      photometricInterpretation: gray ? "MONOCHROME2" : "RGB",
      sizeInBytes: pixels.byteLength,
      dataType: "Uint8Array",
      voxelManager,
    } as unknown as Types.IImage;
    return image;
  });
  return { promise };
}

function registerMetadata(imageId: string, width: number, height: number, gray: boolean) {
  const add = (type: string, metadata: Record<string, unknown>) => utilities.genericMetadataProvider.add(imageId, { type, metadata });
  add("imagePixelModule", {
    samplesPerPixel: gray ? 1 : 3,
    photometricInterpretation: gray ? "MONOCHROME2" : "RGB",
    rows: height,
    columns: width,
    bitsAllocated: 8,
    bitsStored: 8,
    highBit: 7,
    pixelRepresentation: 0,
    planarConfiguration: 0,
  });
  add("imagePlaneModule", {
    // One frame of reference per image: annotations never leak between radiographs.
    frameOfReferenceUID: `inkimg.${imageId}`,
    rows: height,
    columns: width,
    imageOrientationPatient: [1, 0, 0, 0, 1, 0],
    rowCosines: [1, 0, 0],
    columnCosines: [0, 1, 0],
    imagePositionPatient: [0, 0, 0],
    // Unknown physical spacing: tools fall back to pixel units.
    pixelSpacing: undefined,
    rowPixelSpacing: undefined,
    columnPixelSpacing: undefined,
    sliceThickness: 1,
  });
  add("generalSeriesModule", { modality: "OT", seriesInstanceUID: imageId, seriesNumber: 1 });
  add("generalImageModule", { instanceNumber: 1 });
  add("voiLutModule", { windowCenter: [127.5], windowWidth: [255] });
  add("modalityLutModule", { rescaleSlope: 1, rescaleIntercept: 0 });
  add("sopCommonModule", { sopClassUID: "1.2.840.10008.5.1.4.1.1.7", sopInstanceUID: imageId });
}
