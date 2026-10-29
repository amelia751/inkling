import { useEffect } from "react";
import { useCommands } from "@/platform/commands";
import { toggleKeyframe, toggleOccluded, toggleOutside, type TrackGeometry } from "../tracks";
import type { FrameEditor } from "./FrameEditor";
import type { VideoEngine } from "./VideoEngine";

/** Arrows typed into a slider or tab list belong to that control. */
const ownedArrow = (e: KeyboardEvent) => e.key.startsWith("Arrow") && !!(e.target as HTMLElement | null)?.closest?.('[role="slider"],[role="tab"]');
/** Left / Comma step back; Right / Period forward (Shift on , and . arrives as < and >, so match the physical key). */
const back = (e: KeyboardEvent) => e.key === "ArrowLeft" || e.code === "Comma";

/**
 * The video renderer's command handlers (keys, labels and `when`s live in manifest.ts and
 * the core manifest). Space is shared by core `holdToPan` and `playPause`: pressing it
 * starts a hold, dragging while held pans, and releasing without having panned toggles
 * playback. Run through `execute` (agent, menus), `playPause` toggles directly.
 */
export function useVideoCommands(o: {
  engine: VideoEngine;
  editor: FrameEditor;
  fit: () => void;
  editTracks: (fn: (g: TrackGeometry, f: number) => TrackGeometry) => boolean;
  jumpKeyframe: (dir: -1 | 1) => void;
  copyToNext: () => void;
  addEvent: () => void;
}) {
  const { engine, editor } = o;
  const spaceDown = (e?: KeyboardEvent) => {
    if (e?.code !== "Space") return void engine.togglePlay();
    if (!editor.space.down) editor.space = { down: true, panned: false };
  };
  useCommands(
    {
      stepFrame: (e) => (ownedArrow(e) ? false : engine.step(back(e) ? -1 : 1)),
      step10: (e) => (ownedArrow(e) ? false : engine.step(back(e) ? -10 : 10)),
      prevFrame: () => engine.step(-1),
      nextFrame: () => engine.step(1),
      firstLastFrame: (e) => engine.seekEnd(e.key === "Home" ? "first" : "last"),
      toggleLoop: () => engine.setLoop(!engine.getState().loop),
      fitView: () => o.fit(),
      toggleKeyframe: () => void o.editTracks(toggleKeyframe),
      // Without a selected track, O falls through.
      toggleOutside: () => o.editTracks(toggleOutside),
      toggleOccluded: () => o.editTracks(toggleOccluded),
      prevKeyframe: () => o.jumpKeyframe(-1),
      nextKeyframe: () => o.jumpKeyframe(1),
      copyToNextFrame: () => o.copyToNext(),
      holdToPan: spaceDown,
      playPause: spaceDown,
      finishShape: () => editor.finishDraft(),
      addEvent: () => o.addEvent(),
      cancelShape: () => editor.cancelDraft(),
      removeLastVertex: () => editor.removeLastVertex(),
    },
    { scope: ["inkling.video", "inkling.core"] },
  );

  // The release half of the Space hold.
  useEffect(() => {
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space" || !editor.space.down) return;
      const panned = editor.space.panned;
      editor.space = { down: false, panned: false };
      if (!panned) engine.togglePlay();
    };
    const blur = () => (editor.space = { down: false, panned: false });
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [engine, editor]);
}
