import type { Registered } from "@studio/plugin-ui-sdk/resolved";
import { canonicalId } from "@studio/plugin-contracts/naming";
import {
  CONTRIBUTION_TYPES,
  type ContributionOf,
  type ContributionType,
  type ModuleImpl,
  type ModuleManifest,
} from "@studio/plugin-ui-sdk/module";

export type { Registered } from "@studio/plugin-ui-sdk/resolved";

export class RegistryError extends Error {}

export const fullId = (moduleId: string, type: ContributionType, name: string) => `${moduleId}.${type}.${name}`;

/**
 * Indexes modules and their contributions. One instance (`registry`) serves the app; tests
 * create their own with `createRegistry()`.
 */
export interface ActivationResult {
  activated: string[];
  /** Requirements that aren't available (never silently added; docs/plugins.md §14 #11). */
  missing: { module: string; requires: string }[];
}

export class Registry {
  /** Every registered module: what this build *could* run (bundled, known). */
  private modules = new Map<string, ModuleManifest>();
  /**
   * Modules active in the current workspace; `null` = all available (tests, server tooling).
   * Pinned modules (Studio built-ins) are always active.
   */
  private active: Set<string> | null = null;
  private pinned = new Set<string>();
  private byId = new Map<string, Registered<ContributionType>>();
  private impls = new Map<string, Promise<ModuleImpl>>();
  private listeners = new Set<() => void>();
  /** Bumped on every registration so memoised lookups (useSyncExternalStore) can invalidate. */
  version = 0;
  /** Bumped only when the set of active modules changes (registration, activation). */
  activationVersion = 0;

  /** Idempotent: registering the same manifest object twice is a no-op; a different one with the same id throws. */
  registerModule(m: ModuleManifest): void {
    const existing = this.modules.get(m.id);
    if (existing === m) return;
    if (existing) throw new RegistryError(`Module "${m.id}" is already registered`);
    const added: Registered<ContributionType>[] = [];
    for (const type of CONTRIBUTION_TYPES) {
      for (const c of m.contributes[type] ?? []) {
        const id = fullId(m.id, type, c.id);
        if (this.byId.has(id) || added.some((a) => a.id === id)) throw new RegistryError(`Duplicate contribution id "${id}"`);
        added.push({ ...c, id, name: c.id, module: m.id, kind: type } as Registered<ContributionType>);
      }
    }
    this.modules.set(m.id, m);
    for (const c of added) {
      this.byId.set(c.id, c);
      if (c.kind === "presets") this.byId.set(`preset:${c.name}`, c);
    }
    this.changed();
  }

  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private changed(): void {
    this.activationVersion++;
    this.version++;
    this.listeners.forEach((l) => l());
  }

  // ---- Activation (todo2 Phase 3) ----------------------------------------------------------

  /** Modules that are active in every workspace (the Studio core and kits). */
  pin(ids: string[]): void {
    ids.forEach((id) => this.pinned.add(canonicalId(id)));
    this.changed();
  }

  isActive(moduleId: string): boolean {
    const id = canonicalId(moduleId);
    return this.modules.has(id) && (this.active === null || this.active.has(id) || this.pinned.has(id));
  }

  /** Every registered module, active or not. */
  listAvailable(): ModuleManifest[] {
    return [...this.modules.values()];
  }

  activeIds(): string[] {
    return this.listModules().map((m) => m.id);
  }

  /**
   * Make exactly `ids` (plus pinned modules) active, pulling in their `requires` from the
   * available modules. Requirements that aren't available are reported and their
   * dependents stay inactive.
   */
  setActive(ids: string[] | null): ActivationResult {
    if (ids === null) {
      this.active = null;
      this.changed();
      return { activated: [...this.modules.keys()], missing: [] };
    }
    const next = new Set<string>();
    const missing: ActivationResult["missing"] = [];
    const add = (id: string, path: string[]): boolean => {
      const m = this.modules.get(id);
      if (!m) return false;
      if (next.has(id) || this.pinned.has(id)) return true;
      if (path.includes(id)) return true;
      for (const req of m.requires ?? []) {
        const r = canonicalId(req);
        if (!this.modules.has(r)) {
          missing.push({ module: id, requires: r });
          return false;
        }
        if (!add(r, [...path, id])) return false;
      }
      next.add(id);
      return true;
    };
    for (const id of ids.map(canonicalId)) if (this.modules.has(id)) add(id, []);
    this.active = next;
    this.changed();
    return { activated: [...next], missing };
  }

  /** Activate one module (and its available requirements) in the current workspace. */
  activate(moduleId: string): ActivationResult {
    const ids = this.active === null ? [...this.modules.keys()] : [...this.active];
    return this.setActive([...ids, canonicalId(moduleId)]);
  }

  /** Deactivate one module. Its annotations stay in the store; their geometry type shows as unavailable. */
  deactivate(moduleId: string): void {
    const id = canonicalId(moduleId);
    const ids = (this.active === null ? [...this.modules.keys()] : [...this.active]).filter((x) => x !== id);
    // Modules that require it can't stay active without it.
    const keep = ids.filter((x) => !(this.modules.get(x)?.requires ?? []).map(canonicalId).includes(id));
    this.setActive(keep);
  }

  module(id: string): ModuleManifest | undefined {
    const m = this.modules.get(canonicalId(id));
    return m && this.isActive(m.id) ? m : undefined;
  }

  /** A registered module whether or not it's active (manifests, activation UI). */
  availableModule(id: string): ModuleManifest | undefined {
    return this.modules.get(canonicalId(id));
  }

  /** Modules active in the current workspace. Everything below sees active modules only. */
  listModules(): ModuleManifest[] {
    return [...this.modules.values()].filter((m) => this.isActive(m.id));
  }

  /** Active contribution by full id. */
  private find(id: string): Registered<ContributionType> | undefined {
    const c = this.byId.get(canonicalId(id));
    return c && this.isActive(c.module) ? c : undefined;
  }

  has(id: string): boolean {
    return !!this.find(id);
  }

  /** Any contribution by full id, whatever its type. */
  lookup(id: string): Registered<ContributionType> | undefined {
    return this.find(id);
  }

  get<T extends ContributionType>(type: T, id: string): Registered<T> | undefined {
    const c = this.find(id);
    return c && c.kind === type ? (c as unknown as Registered<T>) : undefined;
  }

  list<T extends ContributionType>(type: T, filter?: (c: Registered<T>) => boolean): Registered<T>[] {
    const out: Registered<T>[] = [];
    for (const [key, c] of this.byId)
      if (c.kind === type && key === c.id && this.isActive(c.module) && (!filter || filter(c as unknown as Registered<T>))) out.push(c as unknown as Registered<T>);
    return out;
  }

  /** An inactive module's contribution, for "unavailable type" notices. */
  lookupAvailable(id: string): Registered<ContributionType> | undefined {
    return this.byId.get(canonicalId(id));
  }

  /** Geometry contribution by `geometry.type` (core types are bare, module types `<module>.<name>`). */
  geometry(type: string): Registered<"geometries"> | undefined {
    const t = canonicalId(type);
    return this.list("geometries", (g) => g.type === t)[0];
  }

  /** Modules whose renderers can display a data kind. */
  modulesFor(dataKind: string): ModuleManifest[] {
    const kind = canonicalId(dataKind);
    const ids = new Set(this.list("renderers", (r) => r.consumes.includes(kind)).map((r) => r.module));
    return [...ids].map((id) => this.modules.get(id)!);
  }

  /** Load (once) and cache a module's implementations. */
  loadModule(moduleId: string): Promise<ModuleImpl> {
    let p = this.impls.get(moduleId);
    if (!p) {
      const m = this.modules.get(moduleId);
      if (!m) return Promise.reject(new RegistryError(`Unknown module "${moduleId}"`));
      p = (m.load ? m.load() : Promise.resolve({})).then((x) => ("default" in x && x.default ? x.default : (x as ModuleImpl)));
      p.catch(() => this.impls.delete(moduleId));
      this.impls.set(moduleId, p);
    }
    return p;
  }

  /** The implementation behind a contribution id (renderer component, panel, inspector fn, exporter). */
  async loadImpl<T = unknown>(id: string): Promise<T> {
    const c = this.byId.get(canonicalId(id));
    if (!c) throw new RegistryError(`Unknown contribution "${id}"`);
    const impl = await this.loadModule(c.module);
    const bucket = (impl as Record<string, Record<string, unknown> | undefined>)[c.kind];
    const found = bucket?.[c.name];
    if (found === undefined) throw new RegistryError(`Module "${c.module}" has no implementation for ${c.kind} "${c.name}"`);
    return found as T;
  }

  /** Synchronously available implementation, if the module has already loaded. */
  peekImpl<T = unknown>(id: string): T | undefined {
    const c = this.byId.get(canonicalId(id));
    return c ? (this.loaded.get(c.module) as Record<string, Record<string, unknown>> | undefined)?.[c.kind]?.[c.name] as T | undefined : undefined;
  }

  private loaded = new Map<string, ModuleImpl>();
  /** Like loadModule, but also records the result for peekImpl. */
  async preload(moduleId: string): Promise<void> {
    this.loaded.set(moduleId, await this.loadModule(moduleId));
    this.version++;
    this.listeners.forEach((l) => l());
  }
}

export function createRegistry(modules: ModuleManifest[] = []): Registry {
  const r = new Registry();
  modules.forEach((m) => r.registerModule(m));
  return r;
}

/** The app's registry. Bundled modules are registered by src/bundle.ts. */
export const registry = new Registry();
