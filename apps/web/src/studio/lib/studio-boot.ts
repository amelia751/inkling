import { resolveIntent, type IntentMatch, type IntentTable } from "@studio/studio-tools/intents";
import { useAgent } from "@/studio/stores/agent";
import { newBootId, useBoots } from "@/studio/stores/boots";
import { INTENT_TABLE } from "@/extension-host/bundled";

/**
 * Explicit boots from the person (todo11 D5): the New Studio button and the `/studio <words>`
 * chat command. Both pick the preset from the deterministic table (`registry/intents.json`,
 * the one the agent uses) and call the boot route straight away; no model turn is needed for
 * the first paint.
 */
const INTENTS = INTENT_TABLE as unknown as IntentTable;

export function presetFor(words: string): IntentMatch | null {
  return words.trim() ? resolveIntent(words, INTENTS) : null;
}

/** "chest x-ray" → "Chest x-ray Studio" (the draft task's name). */
export function studioName(words: string): string {
  const w = words.trim().replace(/\s+/g, " ").replace(/\bstudio\b/gi, "").trim();
  return w ? `${w[0].toUpperCase()}${w.slice(1)} Studio`.slice(0, 120) : "";
}

export const STUDIO_COMMAND = /^\/studio(?:\s+([\s\S]*))?$/i;

/**
 * `/studio <words>` typed in the assistant: answered in the browser. The thread gets the
 * command and a boot card (or a hint when no preset matches); the boot route does the rest.
 */
export function runStudioCommand(projectId: string, text: string): void {
  const words = (STUDIO_COMMAND.exec(text.trim())?.[1] ?? "").trim();
  const match = presetFor(words);
  if (!match) {
    useAgent.getState().addLocal(projectId, text, [
      { type: "text", text: words ? `No Studio preset matches “${words}”. Try \`/studio chest x-ray\`, \`/studio CT\`, \`/studio ECG\` or \`/studio video\`.` : "Say what the Studio is for, e.g. `/studio chest x-ray`." },
    ]);
    return;
  }
  const bootId = newBootId();
  useAgent.getState().addLocal(projectId, text, [{ type: "boot", id: bootId }]);
  void useBoots.getState().start(projectId, { bootId, preset: match.preset, name: studioName(words) || undefined });
}
