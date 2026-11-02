import { useEffect, useRef } from "react";
import { matches } from "@studio/ui/keys";
import { fullId, registry } from "./registry";
import type { ResolvedCommand } from "./resolve";
import { when, type WhenContext } from "./when";

/**
 * Commands: named actions contributed by modules (`commands` in a manifest), bound to
 * keys by the resolved environment and handled by whoever is mounted. A handler returns
 * `false` to decline, so the key falls through to lower layers (the shell's Escape still
 * clears the selection when no shape is being drawn).
 *
 * Keyboard dispatch keeps the Studio's priority model: one window listener; higher
 * priority runs first; within a priority, later registrations run first. Renderers use
 * VIEWER_PRIORITY, the shell SHELL_PRIORITY.
 */
import { VIEWER_PRIORITY, type CommandHandler, type CommandHandlers, type KeyHandler } from "@studio/plugin-ui-sdk/host";
export { SHELL_PRIORITY, VIEWER_PRIORITY, type CommandHandler, type CommandHandlers, type KeyHandler } from "@studio/plugin-ui-sdk/host";

// ---- Active environment keymap ------------------------------------------------------

let active = new Map<string, ResolvedCommand>();
let contextProvider: () => WhenContext = () => ({});
const keymapListeners = new Set<() => void>();

/** Called by the Studio when an environment resolves (and with [] when it closes). */
export function setActiveCommands(commands: ResolvedCommand[], context: () => WhenContext = () => ({})): void {
  active = new Map(commands.map((c) => [c.id, c]));
  contextProvider = context;
  keymapListeners.forEach((l) => l());
}

/**
 * What the shell knows outside any environment (todo6 Phase 2): the project section shown
 * (`section == sources`). The Studio's own context wins for the keys it shares.
 */
let shellContext: WhenContext = {};

export function setShellContext(context: WhenContext): void {
  shellContext = context;
}

export function onKeymapChange(l: () => void): () => void {
  keymapListeners.add(l);
  return () => keymapListeners.delete(l);
}

export function activeCommands(): ResolvedCommand[] {
  return [...active.values()];
}

/** The active binding for a command, else its registered defaults (for tooltips outside the Studio). */
export function commandDef(id: string): (ResolvedCommand | (Omit<ResolvedCommand, "keys"> & { keys: string[] })) | undefined {
  const a = active.get(id);
  if (a) return a;
  const c = registry.get("commands", id);
  return c && { ...c, keys: c.keys ?? [] };
}

/**
 * `stepFrame` + scope `studio.cine` → `studio.cine.commands.stepFrame`; full ids pass
 * through. With several scopes, the first whose command is active (or registered) wins, so
 * a renderer can bind its own commands and shared core ones in one map.
 */
export function commandId(name: string, scope?: string | string[]): string {
  if (name.includes(".") || !scope) return name;
  const scopes = Array.isArray(scope) ? scope : [scope];
  const ids = scopes.map((s) => fullId(s, "commands", name));
  return ids.find((id) => active.has(id)) ?? ids.find((id) => registry.has(id)) ?? ids[0];
}

// ---- Imperative handlers (execute / run_command) -----------------------------------

const handlers = new Map<string, CommandHandler[]>();

export function registerCommand(id: string, handler: CommandHandler): () => void {
  handlers.set(id, [...(handlers.get(id) ?? []), handler]);
  return () => handlers.set(id, (handlers.get(id) ?? []).filter((h) => h !== handler));
}

/** Run a command by id (agent `run_command`, menus). Latest handler first; false if nobody handled it. */
export function execute(id: string, args?: unknown): boolean {
  const list = handlers.get(id) ?? [];
  for (let i = list.length - 1; i >= 0; i--) if (list[i](undefined, args) !== false) return true;
  return false;
}

// ---- Keyboard ------------------------------------------------------------------------

type Entry = { priority: number; handler: React.RefObject<KeyHandler> };
const stack: Entry[] = [];

/** Focus inside these owns the keyboard (typing, menus, modal sheets). */
const KEYBOARD_OWNERS = '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[role="combobox"]';

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target.isContentEditable;
}

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

/** Register a raw key handler for the lifetime of the component. Prefer `useCommands`. */
export function useHotkeys(handler: KeyHandler, priority = VIEWER_PRIORITY, enabled = true) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return;
    if (!attached && typeof window !== "undefined") {
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


/**
 * Bind handlers to commands by id. Keys, repeat policy, `when` and labels come from the
 * command contributions as bound by the active environment, so components never
 * hard-code a key. Names without a dot are resolved against `scope` (a module id).
 * Commands the environment doesn't include (disabled, replaced) never fire, except
 * `global` ones (the shell's), which fall back to their declared keys.
 */
export function useCommands(map: CommandHandlers, { priority = VIEWER_PRIORITY, enabled = true, scope, global = false }: { priority?: number; enabled?: boolean; scope?: string | string[]; global?: boolean } = {}) {
  const ref = useRef(map);
  ref.current = map;

  const handle: KeyHandler = (e) => {
      let ctx: WhenContext | undefined;
      for (const name of Object.keys(ref.current)) {
        // `global`: shell commands (navigation, Sources) also work outside the Studio, where no
        // environment is active, with the keys their contribution declares.
        const id = commandId(name, scope);
        const def = active.get(id) ?? (global ? commandDef(id) : undefined);
        if (!def || !def.keys.some((k) => matches(e, k))) continue;
        if (def.when && !when(def.when, (ctx ??= { ...shellContext, ...contextProvider() }))) continue;
        // Held one-shot keys are swallowed so they neither repeat nor leak to lower layers.
        if (e.repeat && !def.repeat) return true;
        if (ref.current[name](e) !== false) return true;
      }
      return false;
  };
  useHotkeys(handle, priority, enabled);

  // Also reachable through execute() for menus and the agent.
  const names = Object.keys(map).join("|");
  const scopeKey = Array.isArray(scope) ? scope.join("|") : scope;
  useEffect(() => {
    if (!enabled) return;
    const scopes = scopeKey?.split("|");
    const offs = names.split("|").filter(Boolean).map((name) => registerCommand(commandId(name, scopes), (e) => ref.current[name]?.(e ?? new KeyboardEvent("keydown"))));
    return () => offs.forEach((off) => off());
  }, [names, scopeKey, enabled]);

  // For widgets that own their keys (a tree, a dialog): run the bound commands from their own
  // key handler first, so the keys still come from the command contributions.
  return (e: KeyboardEvent): boolean => enabled && handle(e) === true;
}
