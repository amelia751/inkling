import { nameStem, splitExtension } from "@studio/ui/file-names";

/**
 * Name rules (todo7 D10), checked live in the rename field and before every create. The
 * server checks the same rules (422 `{ detail }`); these give the sentence before a round trip.
 *
 * - unique per folder, case-insensitively (exports to macOS and Windows don't collide);
 * - no `/`, no control characters, at most 255 UTF-8 bytes, not `.` or `..`, not empty;
 * - trailing spaces and dots are trimmed (`normalizeName`);
 * - Windows reserved names (`CON`, `NUL`, …) only warn;
 * - an extension change asks for confirmation ("The file's content won't change").
 */

export { splitExtension };

/** The name without its extension (`scan.nii.gz` → `scan`). */
export const stem = (name: string): string => nameStem(name);

/** What the server stores: trailing spaces and dots trimmed (leading spaces kept, as Finder does). */
export const normalizeName = (name: string): string => name.replace(/[\s.]+$/u, "");

const CONTROL = /[\u0000-\u001f\u007f]/u;
const encoder = new TextEncoder();

export interface NameCheckOptions {
  /** Says "A file named …" or "A folder named …" in the conflict sentence. */
  isFile?: boolean;
  /** The node being renamed (its own current name is not a conflict). */
  current?: string;
}

/**
 * The first rule `name` breaks, as a sentence for under the field, or null when it's fine.
 * `siblings` are the names already in the folder (trashed ones excluded).
 */
export function validateName(name: string, siblings: Iterable<string>, { isFile = false, current }: NameCheckOptions = {}): string | null {
  const raw = name.trim();
  if (raw === "." || raw === "..") return `“${raw}” can't be used as a name`;
  const n = normalizeName(name);
  if (!n.trim()) return "Type a name";
  if (n.includes("/")) return "Names can't contain “/”";
  if (CONTROL.test(n)) return "Names can't contain control characters";
  if (encoder.encode(n).length > 255) return "That name is too long (255 bytes at most)";
  const lower = n.toLowerCase();
  if (current !== undefined && current.toLowerCase() === lower) return null;
  for (const s of siblings) {
    if (s.toLowerCase() === lower && s !== current) return `A ${isFile ? "file" : "folder"} named “${s}” is already here`;
  }
  return null;
}

const RESERVED = new Set(["CON", "PRN", "AUX", "NUL", ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`)]);

/** A warning (never a block) for names Windows reserves, with or without an extension. */
export function windowsReservedWarning(name: string): string | null {
  const base = normalizeName(name).split(".")[0].trim().toUpperCase();
  return RESERVED.has(base) ? `“${base}” is reserved on Windows, so this may not copy there` : null;
}

/** True when a rename changes a file's extension (ask first: the content won't change). */
export function extensionChanged(oldName: string, newName: string): boolean {
  return splitExtension(oldName)[1].toLowerCase() !== splitExtension(normalizeName(newName))[1].toLowerCase();
}

const lowerSet = (names: Iterable<string>) => new Set([...names].map((n) => n.toLowerCase()));

/** "Untitled folder", then "Untitled folder 2", "Untitled folder 3"… (the first free one). */
export function nextUntitled(siblings: Iterable<string>, base = "Untitled folder"): string {
  const taken = lowerSet(siblings);
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** Conflict "Keep both": `scan001.dcm` → `scan001 (2).dcm`, then `(3)`…; a name already ending in `(n)` counts on from n. */
export function keepBothName(name: string, siblings: Iterable<string>): string {
  const taken = lowerSet(siblings);
  if (!taken.has(name.toLowerCase())) return name;
  const [s, ext] = splitExtension(name);
  const m = /^(.*) \((\d+)\)$/u.exec(s);
  const root = m ? m[1] : s;
  for (let i = m ? Number(m[2]) + 1 : 2; ; i++) {
    const candidate = `${root} (${i})${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** Duplicate: `name (copy).ext`, then `name (copy 2).ext`… */
export function copyName(name: string, siblings: Iterable<string> = []): string {
  const taken = lowerSet(siblings);
  const [s, ext] = splitExtension(name);
  const first = `${s} (copy)${ext}`;
  if (!taken.has(first.toLowerCase())) return first;
  for (let i = 2; ; i++) {
    const candidate = `${s} (copy ${i})${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}
