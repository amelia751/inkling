/**
 * Media types for asset paths, used by `visibleWhen.assetMediaType` and capability
 * `mediaTypes`. Extension-based on purpose: assets are addressed by path in the manifest,
 * and the kernel's Asset API returns the same strings from its metadata.
 */
const BY_EXT: [RegExp, string][] = [
  [/\.png$/i, "image/png"],
  [/\.jpe?g$/i, "image/jpeg"],
  [/\.webp$/i, "image/webp"],
  [/\.tiff?$/i, "image/tiff"],
  [/\.svs$/i, "image/tiff"],
  [/\.dzi$/i, "application/x-dzi"],
  [/\.dcm$/i, "application/dicom"],
  [/\.nii(\.gz)?$/i, "application/x-nifti"],
  [/\.(mp4|m4v)$/i, "video/mp4"],
  [/\.webm$/i, "video/webm"],
  [/\.(hea|dat)$/i, "application/x-wfdb"],
  [/\.csv$/i, "text/csv"],
  [/\.json$/i, "application/json"],
  [/\.txt$/i, "text/plain"],
  [/\.md$/i, "text/markdown"],
];

export function mediaTypeOf(path: string): string {
  for (const [re, type] of BY_EXT) if (re.test(path)) return type;
  return "application/octet-stream";
}

/** `image/*` style match. */
export function mediaTypeMatches(type: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => p === type || (p.endsWith("/*") && type.startsWith(p.slice(0, -1))));
}
