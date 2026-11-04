/**
 * Drops (todo13-drops): files dropped, pasted or attached anywhere become Files first, grouped
 * as one drop per gesture. Home, the Studio canvas and the composer all start them with
 * `startDrop`; `DropCard` shows one, `SharedFiles` a conversation's. Drop plans (todo13
 * Milestone 2): the plan card and its store, and the live refresh of an open Studio when a drop is
 * applied to its collection.
 */
export { dropsApi, newDropId } from "./api";
export { DropCard, type DropCardProps } from "./drop-card";
export { AttachmentTiles, tileState, type AttachmentTilesProps, type TileState } from "./attachment-tiles";
export { chipsOf, dropKeys, useChatDropsEnabled, useConversationDrops, useDrop, useDropChips, useDropEvents, type Chip } from "./hooks";
export { SharedFiles } from "./shared-files";
export { cancelDrop, pastedFiles, resumeDrop, startDrop, whenRegistered, type StartDropOptions } from "./start";
export { useDrops, type LocalDrop } from "./store";
export { DropPlanCards, PlanCard } from "./PlanCard";
export { usePlans, type PlanView } from "./plans";
export { useLiveDropItems } from "./live";
