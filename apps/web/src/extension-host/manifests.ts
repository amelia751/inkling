import yaml from "js-yaml";
import { canonicalDoc } from "@studio/contracts/naming";
import { PluginManifest } from "@studio/contracts/plugin-manifest";
import { UiContributions } from "@studio/contracts/ui-contributions";

/**
 * Data-only plugin manifests (todo2 §2.2): every `plugins/<name>/plugin.yaml` and its
 * optional `ui/contributions.json`, read at build time and validated against the contracts.
 * The registry, installer and agent reason about plugins from these without running code.
 */
export interface PluginPackage {
  /** Folder under plugins/. */
  dir: string;
  manifest: PluginManifest;
  contributions?: UiContributions;
}

export interface ManifestProblem {
  dir: string;
  file: string;
  errors: string[];
}

const issues = (e: { issues: { path: PropertyKey[]; message: string }[] }) => e.issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`);

/** Parse and validate one plugin.yaml text. */
export function parsePluginManifest(text: string): { manifest: PluginManifest; errors?: undefined } | { manifest?: undefined; errors: string[] } {
  let raw: unknown;
  try {
    raw = yaml.load(text, { schema: yaml.JSON_SCHEMA });
  } catch (e) {
    return { errors: [`YAML: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const r = PluginManifest.safeParse(canonicalDoc(raw));
  return r.success ? { manifest: r.data } : { errors: issues(r.error) };
}

export function parseUiContributions(raw: unknown): { contributions: UiContributions; errors?: undefined } | { contributions?: undefined; errors: string[] } {
  const r = UiContributions.safeParse(canonicalDoc(raw));
  return r.success ? { contributions: r.data } : { errors: issues(r.error) };
}

const yamlFiles = import.meta.glob<string>("../../../../plugins/*/plugin.yaml", { query: "?raw", import: "default", eager: true });
const uiFiles = import.meta.glob<unknown>("../../../../plugins/*/ui/contributions.json", { import: "default", eager: true });
const dirOf = (path: string) => /plugins\/([^/]+)\//.exec(path)![1];

/** Load every bundled plugin package. Invalid ones are reported in `problems`, never registered. */
export function loadPluginPackages(files = yamlFiles, ui = uiFiles): { packages: PluginPackage[]; problems: ManifestProblem[] } {
  const packages: PluginPackage[] = [];
  const problems: ManifestProblem[] = [];
  const uiByDir = new Map(Object.entries(ui).map(([p, v]) => [dirOf(p), [p, v] as const]));
  for (const [path, text] of Object.entries(files)) {
    const dir = dirOf(path);
    const m = parsePluginManifest(text);
    if (m.errors) {
      problems.push({ dir, file: "plugin.yaml", errors: m.errors });
      continue;
    }
    const pkg: PluginPackage = { dir, manifest: m.manifest };
    const declared = m.manifest.ui?.contributions;
    const found = uiByDir.get(dir);
    if (declared && !found) problems.push({ dir, file: declared, errors: [`plugin.yaml names ${declared}, which doesn't exist`] });
    if (found) {
      const c = parseUiContributions(found[1]);
      if (c.errors) problems.push({ dir, file: "ui/contributions.json", errors: c.errors });
      else pkg.contributions = c.contributions;
    }
    packages.push(pkg);
  }
  return { packages: packages.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id)), problems };
}

export const PLUGIN_PACKAGES = loadPluginPackages();
