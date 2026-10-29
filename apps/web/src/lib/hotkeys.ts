import { useEffect, useRef } from "react";
import { parseCombo, SHORTCUTS, type ShortcutDef, type ShortcutId } from "./shortcuts";

/** Return true when the key was handled; lower layers then never see it. */
export type KeyHandler = (e: KeyboardEvent) => boolean | void;

/**
 * One window listener for the whole Studio. Higher-priority handlers run first; within a
 * priority, later registrations run first. Viewers use VIEWER_PRIORITY and the Studio
 * shell registers at SHELL_PRIORITY, so a viewer can claim e.g. Escape while a shape is
 * in progress while the shell keeps it for clearing the selection everywhere else.
 */
export const VIEWER_PRIORITY = 0;
export const SHELL_PRIORITY = -10;

type Entry = { priority: number; handler: React.RefObject<KeyHandler> };
const stack: Entry[] = [];

/** Focus inside these owns the keyboard (typing, menus, modal sheets). */
const KEYBOARD_OWNERS = '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[role="combobox"]';

function dispatch(e: KeyboardEvent) {
  if (e.defaultPrevented || e.isComposing || isTypingTarget(e.target)) return;
  if (e.target instanceof Element && e.target.closest(KEYBOARD_OWNERS)) return;
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].handler.current?.(e)) {
      e.preventDefault();
      return;
    }
  }
}

let attached = false;

/** Register a raw key handler for the lifetime of the component. Prefer `useShortcuts`. */
export function useHotkeys(handler: KeyHandler, priority = VIEWER_PRIORITY, enabled = true) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return;
    if (!attached) {
      window.addEventListener("keydown", dispatch);
      attached = true;
    }
    const entry = { priority, handler: ref };
    // Keep the stack sorted ascending by priority; dispatch walks it from the end.
    const at = stack.findIndex((x) => x.priority > priority);
    stack.splice(at === -1 ? stack.length : at, 0, entry);
    return () => {
      stack.splice(stack.indexOf(entry), 1);
    };
  }, [priority, enabled]);
}

/** Return false from a handler to decline the key so lower layers can take it. */
export type ShortcutHandlers = Partial<Record<ShortcutId, (e: KeyboardEvent) => boolean | void>>;

/**
 * Bind handlers to registry shortcuts by id. Keys, auto-repeat policy and labels all
 * come from `SHORTCUTS`, so components never hard-code a key.
 */
export function useShortcuts(handlers: ShortcutHandlers, { priority = VIEWER_PRIORITY, enabled = true } = {}) {
  useHotkeys(
    (e) => {
      for (const id of Object.keys(handlers) as ShortcutId[]) {
        const def: ShortcutDef = SHORTCUTS[id];
        if (!def.keys.some((k) => matches(e, k))) continue;
        // Held one-shot keys are swallowed so they neither repeat nor leak to lower layers.
        if (e.repeat && !def.repeat) return true;
        if (handlers[id]!(e) !== false) return true;
      }
      return false;
    },
    priority,
    enabled,
  );
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target.isContentEditable;
}

/** Keys matched by physical position, so they work where the character needs Shift (e.g. AZERTY digits). */
const PHYSICAL: Record<string, string> = { "[": "BracketLeft", "]": "BracketRight", ",": "Comma", ".": "Period", space: "Space" };

/** Match a combo like "mod+z", "shift+]", "alt+e", "Delete" or "1". See `lib/shortcuts.ts` for the syntax. */
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
