/**
 * Canonical types and schemas (todo/done/todo2.md §1.2): annotations, geometries, projects and
 * items, the environment spec, the annotation migration and the naming config. Shared by
 * the web app, plugins and (through emitted JSON Schemas) the Python kernel.
 */
export * from "./naming";
export * from "./types";
export * from "./environment";
export * from "./plugin-manifest";
export * from "./annotation-revision";
export * from "./annotation-diff";
export * from "./ui-contributions";
export * from "./workspace";
export * from "./media-types";
export * from "./converter";
export { CAPABILITIES } from "./capabilities";
export * from "./boundary";
