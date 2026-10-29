import { createStore, useStore } from "zustand";
import type { RuntimeApi } from "./module";

/**
 * Per-item runtime context. Renderers publish live values here (playhead, grid spacing,
 * signal sample rate, viewport state, structured status); inspectors and panels read them.
 * Replaces the module-level singletons viewers used to keep for this.
 *
 * Well-known keys (docs/modules.md): `playhead` ({ frame, time }), `grid` ({ spacing, dims }),
 * `signalInfo` ({ fs, … }), `viewportState`, `status`.
 */
type Values = Record<string, Record<string, unknown>>;

export const runtimeStore = createStore<{ values: Values }>(() => ({ values: {} }));

export function publish(itemId: string, key: string, value: unknown): void {
  const { values } = runtimeStore.getState();
  if (values[itemId]?.[key] === value) return;
  runtimeStore.setState({ values: { ...values, [itemId]: { ...values[itemId], [key]: value } } });
}

export function getRuntime<T = unknown>(itemId: string, key: string): T | undefined {
  return runtimeStore.getState().values[itemId]?.[key] as T | undefined;
}

export function useRuntime<T = unknown>(itemId: string | undefined, key: string): T | undefined {
  return useStore(runtimeStore, (s) => (itemId ? (s.values[itemId]?.[key] as T | undefined) : undefined));
}

/** Drop everything published for one item (or all items), e.g. when a project closes. */
export function clearRuntime(itemId?: string): void {
  if (!itemId) return runtimeStore.setState({ values: {} });
  const { [itemId]: _, ...rest } = runtimeStore.getState().values;
  runtimeStore.setState({ values: rest });
}

/** The scoped API handed to renderers and inspectors through props. */
export function runtimeFor(itemId: string): RuntimeApi {
  return {
    publish: (key, value) => publish(itemId, key, value),
    get: (key) => getRuntime(itemId, key),
  };
}

/** Re-render whenever anything is published for an item (for readers that go through `runtime.get`). */
export function useRuntimeVersion(itemId: string | undefined): Record<string, unknown> | undefined {
  return useStore(runtimeStore, (s) => (itemId ? s.values[itemId] : undefined));
}
