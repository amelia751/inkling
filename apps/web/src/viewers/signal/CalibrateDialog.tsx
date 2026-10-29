import { useRef, useState } from "react";
import { CARD_MM } from "./calibration";
import { PX_PER_MM } from "./layout";

interface Props {
  /** Current CSS px per mm. */
  pxPerMm: number;
  calibrated: boolean;
  onSave: (cssPxPerMm: number | null) => void;
  onClose: () => void;
}

/**
 * Drag the bar's right handle until it is exactly as long as a credit card's long edge
 * (85.60 mm). Arrow keys on the handle nudge by 1 px (Shift: 10 px).
 */
export function CalibrateDialog({ pxPerMm, calibrated, onSave, onClose }: Props) {
  const [width, setWidth] = useState(Math.round(pxPerMm * CARD_MM));
  const drag = useRef<{ x0: number; w0: number } | null>(null);
  const clampW = (w: number) => Math.max(120, Math.min(900, w));
  const k = width / CARD_MM;

  return (
    <div
      role="dialog"
      aria-label="Calibrate screen"
      className="absolute top-2 left-1/2 z-30 w-[min(960px,calc(100%-16px))] -translate-x-1/2 rounded-md border border-white/15 bg-canvas p-3 text-xs shadow-xl"
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <div className="mb-1 font-semibold">Calibrate screen for true paper scale</div>
      <p className="mb-3 text-canvas-foreground/65">
        Hold a credit card (85.60 mm) flat against the screen and drag the handle until the bar matches its long edge. Arrow keys on the handle nudge 1 px (Shift: 10 px).
      </p>
      <div className="relative mb-3 h-12">
        <div data-testid="calib-bar" className="absolute top-2 left-0 h-8 rounded-l-sm border border-primary bg-primary/25" style={{ width }} />
        <button
          data-testid="calib-handle"
          autoFocus
          aria-label={`Bar length ${width} px`}
          className="absolute top-0 h-12 w-3 cursor-ew-resize rounded-sm bg-primary"
          style={{ left: width - 6 }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { x0: e.clientX, w0: width };
          }}
          onPointerMove={(e) => drag.current && setWidth(clampW(Math.round(drag.current.w0 + e.clientX - drag.current.x0)))}
          onPointerUp={() => (drag.current = null)}
          onKeyDown={(e) => {
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
            e.preventDefault();
            e.stopPropagation();
            setWidth((w) => clampW(w + (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 10 : 1)));
          }}
        />
      </div>
      <div className="flex items-center gap-2">
        <span className="tnum text-canvas-foreground/70" data-testid="calib-readout">
          {width} px = 85.60 mm · {k.toFixed(3)} px/mm{calibrated ? "" : " (uncalibrated: CSS 3.780 px/mm)"}
        </span>
        <div className="ml-auto flex gap-1">
          <button className="rounded-md px-2 py-1 hover:bg-white/10" onClick={() => setWidth(Math.round(PX_PER_MM * CARD_MM))}>
            CSS default
          </button>
          {calibrated && (
            <button className="rounded-md px-2 py-1 hover:bg-white/10" onClick={() => onSave(null)}>
              Clear calibration
            </button>
          )}
          <button className="rounded-md px-2 py-1 hover:bg-white/10" onClick={onClose}>
            Cancel
          </button>
          <button className="rounded-md bg-primary px-2 py-1 text-primary-foreground" onClick={() => onSave(k)}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
