import { useEffect, useRef, useState, type RefObject } from "react";
import type { Placement } from "@studio/contracts/types";
import { OverlayEngine, type OverlayEngineOptions } from "./OverlayEngine";
import type { ToolMachine, Units } from "./tools";
import type { Transform2D } from "./transform";

export interface UseOverlay2DOptions {
  itemId: string;
  /** The host's image ↔ screen map, e.g. `new View().setCamera(camera, w, h)` from useViewport2D. */
  transform: Transform2D;
  /** Change it whenever the transform changed (camera object, frame counter…) to redraw. */
  transformVersion?: unknown;
  /** Show and edit only annotations on this frame / slice (video, cine); new ones are stamped with it. */
  placement?: Placement;
  labels: string[];
  units?: Units;
  tools?: Record<string, ToolMachine>;
  accepts?: OverlayEngineOptions["accepts"];
  reveal?: OverlayEngineOptions["reveal"];
}

/**
 * React binding for OverlayEngine on a host that isn't OpenSeadragon: mounts the overlay
 * canvases in `stageRef`, keeps them sized to it, redraws when the transform changes and
 * re-filters when the placement does. Unclaimed presses (empty canvas with the select
 * tool, the `pan` tool, Space held) are left to the host, which pans its camera.
 *
 * Bind keys in the host with `useCommands({ cancelShape: () => engine?.cancelShape() ?? false, … })`.
 */
export function useOverlay2D(stageRef: RefObject<HTMLElement | null>, o: UseOverlay2DOptions): { engine: OverlayEngine | null; hint: string | null; busy: boolean } {
  const [engine, setEngine] = useState<OverlayEngine | null>(null);
  const [state, setState] = useState<{ hint: string | null; busy: boolean }>({ hint: null, busy: false });
  const latest = useRef(o);
  latest.current = o;

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const cur = latest.current;
    const e = new OverlayEngine({
      stage,
      itemId: cur.itemId,
      view: cur.transform,
      labels: () => latest.current.labels,
      units: cur.units,
      placement: cur.placement,
      tools: cur.tools,
      accepts: (t) => latest.current.accepts?.(t) ?? true,
      reveal: (bb) => latest.current.reveal?.(bb),
      onState: setState,
    });
    const ro = new ResizeObserver(() => {
      e.resize();
      e.drawNow();
    });
    ro.observe(stage);
    e.resize();
    e.setReady();
    setEngine(e);
    return () => {
      ro.disconnect();
      e.destroy();
      setEngine(null);
    };
  }, [stageRef, o.itemId]);

  useEffect(() => {
    if (!engine) return;
    engine.view = o.transform;
    engine.drawNow();
  }, [engine, o.transform, o.transformVersion]);

  useEffect(() => {
    engine?.setPlacement(o.placement);
  }, [engine, o.placement?.frame, o.placement?.slice, o.placement?.plane]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (engine && o.units) engine.setUnits(o.units);
  }, [engine, o.units]);

  return { engine, ...state };
}
