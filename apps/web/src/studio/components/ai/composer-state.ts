import type { ChipState } from "@/studio/core/drops/progress";

/**
 * todo29 D5: what the composer's button and Enter do. `busy` is a run streaming in this chat or
 * the assistant following a drop it was sent (it will wake on it). The button is Stop whenever
 * busy, even with text typed or files attached; Enter while busy queues the message.
 */
export const composerBusy = (running: boolean, following: boolean) => running || following;

export const composerButton = (busy: boolean): "stop" | "send" => (busy ? "stop" : "send");

/** Enter: send now, or queue behind the current work. Nothing to send is a no-op. */
export function composerEnter(state: { busy: boolean; text: string; canSend: boolean; queued: string[] }): { send?: string; queued: string[] } {
  if (!state.canSend) return { queued: state.queued };
  if (state.busy) return { queued: [...state.queued, state.text] };
  return { send: state.text, queued: state.queued };
}

/** A file still on its way: uploading, or being checked (the assistant may still wake on it). */
const MOVING: ReadonlySet<ChipState> = new Set<ChipState>(["confirming", "preparing", "uploading", "checking"]);

/**
 * todo29 D5: the drop the assistant follows is settled once no file is moving. A drop that
 * stopped (interrupted upload, gone on the server) is settled too: nothing more will happen.
 */
export function dropSettled(d: { chips: { state: ChipState }[]; loading?: boolean; interrupted?: boolean; missing?: boolean }): boolean {
  if (d.interrupted || d.missing) return true;
  if (d.loading || d.chips.length === 0) return false;
  return !d.chips.some((c) => MOVING.has(c.state));
}
