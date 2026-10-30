/**
 * Key-combo syntax shared by commands, tools and label hotkeys.
 *
 * Modifiers `mod` (⌘ on macOS, Ctrl elsewhere), `alt`, `shift`, joined with `+`.
 * Letters match the character typed (so Dvorak and AZERTY users press the letter
 * they see); digits and `[ ] , . space` match the physical key, so they work on
 * layouts where those characters need Shift.
 */

export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export interface ParsedCombo {
  mod: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

const parsed = new Map<string, ParsedCombo>();

export function parseCombo(combo: string): ParsedCombo {
  let p = parsed.get(combo);
  if (!p) {
    // "+" on its own or at the end is the key itself, not a separator.
    const parts = combo.length > 1 && combo.endsWith("+") ? [...combo.slice(0, -2).split("+"), "+"] : combo.split("+");
    const key = parts.pop()!;
    const mods = new Set(parts.map((m) => m.toLowerCase()));
    p = { mod: mods.has("mod"), alt: mods.has("alt"), shift: mods.has("shift"), key: key.length === 1 ? key.toLowerCase() : key };
    parsed.set(combo, p);
  }
  return p;
}

export function normalizeCombo(combo: string): string {
  const p = parseCombo(combo);
  return [p.mod && "mod", p.alt && "alt", p.shift && "shift", p.key].filter(Boolean).join("+");
}

const KEY_NAMES: Record<string, [mac: string, other: string]> = {
  ArrowUp: ["↑", "↑"],
  ArrowDown: ["↓", "↓"],
  ArrowLeft: ["←", "←"],
  ArrowRight: ["→", "→"],
  Escape: ["Esc", "Esc"],
  Delete: ["⌦", "Del"],
  Backspace: ["⌫", "Backspace"],
  Enter: ["↵", "Enter"],
  PageUp: ["PgUp", "PgUp"],
  PageDown: ["PgDn", "PgDn"],
  space: ["Space", "Space"],
};

/** Display parts for one combo, e.g. ["⇧", "⌘", "Z"] on macOS or ["Shift", "Ctrl", "Z"] elsewhere. */
export function comboParts(combo: string): string[] {
  const p = parseCombo(combo);
  const name = KEY_NAMES[p.key]?.[IS_MAC ? 0 : 1] ?? p.key.toUpperCase();
  return [
    p.shift && (IS_MAC ? "⇧" : "Shift"),
    p.alt && (IS_MAC ? "⌥" : "Alt"),
    p.mod && (IS_MAC ? "⌘" : "Ctrl"),
    name,
  ].filter((x): x is string => !!x);
}

/** One combo as a single string: "⇧⌘Z" on macOS, "Shift+Ctrl+Z" elsewhere. */
export function formatCombo(combo: string): string {
  return comboParts(combo).join(IS_MAC ? "" : "+");
}

/** Keys matched by physical position, so they work where the character needs Shift (e.g. AZERTY digits). */
const PHYSICAL: Record<string, string> = { "[": "BracketLeft", "]": "BracketRight", ",": "Comma", ".": "Period", space: "Space" };

/** Match a combo like "mod+z", "shift+]", "alt+e", "Delete" or "1" against a key event. */
export function matches(e: KeyboardEvent, combo: string): boolean {
  const p = parseCombo(combo);
  if (p.mod !== (e.metaKey || e.ctrlKey)) return false;
  if (p.alt !== e.altKey) return false;
  const { key } = p;

  if (/^[0-9]$/.test(key)) return p.shift === e.shiftKey && (e.code === `Digit${key}` || e.code === `Numpad${key}`);
  if (PHYSICAL[key]) return p.shift === e.shiftKey && e.code === PHYSICAL[key];
  if (/^[a-z]$/.test(key)) {
    if (p.shift !== e.shiftKey) return false;
    const typed = e.key.toLowerCase();
    // Non-Latin layouts (Cyrillic, Greek…) fall back to the physical letter.
    return /^[a-z]$/.test(typed) ? typed === key : e.code === `Key${key.toUpperCase()}`;
  }
  // Named keys (Tab, Enter, ArrowLeft…) need an exact Shift match, or "Tab" would also fire on Shift+Tab.
  if (key.length > 1) return p.shift === e.shiftKey && e.key.toLowerCase() === key.toLowerCase();
  // Symbols such as "?": Shift is implied by the character itself.
  if (p.shift && !e.shiftKey) return false;
  return e.key === key || e.key.toLowerCase() === key.toLowerCase();
}

/** The digit 1–9 pressed, by physical key, or null. */
export function digitOf(e: KeyboardEvent): number | null {
  const m = /^(?:Digit|Numpad)([0-9])$/.exec(e.code);
  return m ? +m[1] : null;
}

/** "⌥ + arrows" / "Shift+Alt + arrows": the display string for arrow-key families. */
export const modArrows = (mods: "alt" | "shift+alt") => `${mods === "alt" ? (IS_MAC ? "⌥" : "Alt") : IS_MAC ? "⇧⌥" : "Shift+Alt"} + arrows`;
