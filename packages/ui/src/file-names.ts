/**
 * File-name helpers shared by the tree's rename field and the app's name rules (todo7 D10).
 * Pure; no React.
 */

/** Extensions that span two dots: `scan.nii.gz` has the stem `scan`, not `scan.nii`. */
const MULTI_EXTENSIONS = [".nii.gz", ".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst", ".dcm.gz", ".csv.gz", ".tsv.gz", ".json.gz", ".mha.gz", ".mhd.gz", ".nrrd.gz"]

/**
 * Split a file name into stem and extension (`"scan001.dcm"` → `["scan001", ".dcm"]`,
 * `"t1.nii.gz"` → `["t1", ".nii.gz"]`). Dotfiles (`.env`) and names without a dot have no
 * extension.
 */
export function splitExtension(name: string): [stem: string, ext: string] {
  const lower = name.toLowerCase()
  for (const ext of MULTI_EXTENSIONS) {
    if (lower.endsWith(ext) && name.length > ext.length) return [name.slice(0, -ext.length), name.slice(-ext.length)]
  }
  const dot = name.lastIndexOf(".")
  if (dot <= 0 || dot === name.length - 1) return [name, ""]
  return [name.slice(0, dot), name.slice(dot)]
}

/** The name without its extension (what a rename field selects on focus, Finder-style). */
export const nameStem = (name: string): string => splitExtension(name)[0]
