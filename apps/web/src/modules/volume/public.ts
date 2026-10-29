/** What other modules may import from inkling.volume (types and pure helpers only). */
export { VOLUME, VOLUME_KIND, volumeSources, initialSource, referenceAsset, type VolumeSource } from "./dataKind";
export { LAYOUT_IDS, cellsFor, mprConfigSchema, type Cell, type Layout, type MprConfig } from "./config";
export { labelValue, labelIndexForValue, isBrats } from "./labelValues";
