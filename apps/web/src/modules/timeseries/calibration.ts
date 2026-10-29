import { useEffect, useState } from "react";
import { PX_PER_MM } from "./renderer/layout";

/**
 * Screen calibration for true paper scale.
 *
 * CSS assumes 96 px per inch, which is rarely the physical truth. The user calibrates once by
 * matching an on-screen bar to a credit card (ISO/IEC 7810 ID-1: 85.60 mm). We store DEVICE
 * pixels per mm (CSS px/mm × devicePixelRatio at calibration time): Chrome, Edge and Firefox
 * fold browser zoom into devicePixelRatio, so dividing by the current ratio keeps a calibrated
 * millimetre physically constant when the user zooms the page.
 *
 * Limitation: moving the window to a monitor with a different pixel density needs a new
 * calibration (we cannot tell zoom from a different screen). Safari does not report page zoom
 * in devicePixelRatio, so calibrate at the zoom level you work at there.
 */
export const CARD_MM = 85.6;
const KEY = "inkling.signal.devicePxPerMm.v1";

export function loadDevicePxPerMm(): number | null {
  try {
    const v = parseFloat(localStorage.getItem(KEY) ?? "");
    return Number.isFinite(v) && v > 0.5 && v < 100 ? v : null;
  } catch {
    return null;
  }
}

export function saveDevicePxPerMm(v: number | null) {
  try {
    if (v === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(v));
  } catch {
    // storage unavailable: calibration lasts for this session only
  }
}

/** Current devicePixelRatio, updated when it changes (browser zoom, moving to another screen). */
export function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  useEffect(() => {
    const mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const on = () => setDpr(window.devicePixelRatio || 1);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [dpr]);
  return dpr;
}

/**
 * CSS px per mm for paper mode: calibrated device px/mm ÷ current devicePixelRatio, else the
 * CSS reference 96/25.4.
 */
export function useScreenScale() {
  const dpr = useDevicePixelRatio();
  const [device, setDevice] = useState<number | null>(loadDevicePxPerMm);
  const set = (cssPxPerMm: number | null) => {
    const v = cssPxPerMm === null ? null : cssPxPerMm * dpr;
    saveDevicePxPerMm(v);
    setDevice(v);
  };
  return { pxPerMm: device ? device / dpr : PX_PER_MM, calibrated: device !== null, dpr, setCssPxPerMm: set };
}
