import OpenSeadragon from "openseadragon";
import { OverlayEngine } from "@studio/renderers/overlay2d/OverlayEngine";
import type { ToolContext, Units } from "@studio/renderers/overlay2d/tools";
import { View } from "@studio/renderers/overlay2d/transform";
import { resolveToken } from "@studio/plugin-ui-sdk/labels";
import { viewPath, type Pt, type SeedAsset, type StudioItem } from "@studio/contracts/types";
import { formatArea, formatLength, lengthStats } from "../measure";
import { syncViewFromOSD } from "./osdView";
import { lastWandRunner, NEUTRAL_ADJUST, wandRegion, wandTool, type Adjustments } from "./wand";
import { assetUrl, toolOption } from "@studio/plugin-ui-sdk";

export interface UiState {
  ready: boolean;
  error: string | null;
  /** Current optical magnification equivalent (objective × image zoom). */
  mag: number;
  rotation: number;
  flipped: boolean;
  showNames: boolean;
  busy: boolean;
  hint: string | null;
  drawer: string;
}

export const INITIAL_UI: UiState = { ready: false, error: null, mag: 0, rotation: 0, flipped: false, showNames: false, busy: false, hint: null, drawer: "" };

const NICE_UM = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];

/** Lengths and areas in µm from the slide's mpp (pixels when it is unknown), with a µm/mm scale bar. */
export function micronUnits(mpp: number | null): Units {
  return {
    formatLength: (px) => formatLength(px, mpp),
    formatArea: (px2) => formatArea(px2, mpp),
    lengthStats: (px) => lengthStats(px, mpp),
    unit: mpp ? "µm" : "px",
    scaleBar: mpp ? { perPx: mpp, steps: NICE_UM, format: (n) => (n >= 1000 ? `${n / 1000} mm` : `${n} µm`) } : undefined,
  };
}

export interface ControllerOptions {
  stage: HTMLDivElement;
  host: HTMLDivElement;
  item: StudioItem;
  asset: SeedAsset;
  labels: () => string[];
  mpp: number | null;
  objective: number;
  showNavigator: boolean;
  onUi: (ui: UiState) => void;
}

/**
 * Owns the OpenSeadragon viewer: tile pyramid, navigator, the OSD → overlay transform,
 * zoom / rotation / flip and colour adjustments, and the magic wand's pixel access.
 * Drawing, hit-testing and every other tool live in kits/overlay2d's OverlayEngine,
 * whose canvases sit inside OSD's canvas element (above the tiles, below the navigator).
 */
export class WsiController {
  readonly viewer: OpenSeadragon.Viewer;
  readonly view = new View();
  readonly engine: OverlayEngine;
  readonly stage: HTMLDivElement;
  readonly item: StudioItem;
  readonly mpp: number | null;
  readonly objective: number;
  ui: UiState = { ...INITIAL_UI };
  adjust: Adjustments = { ...NEUTRAL_ADJUST };
  /** Where the last wand fill ran ("worker" normally; "inline" if workers are unavailable). */
  wandRunner: "worker" | "inline" | null = null;
  private imageW: number;
  private imageH: number;
  private resizeObserver: ResizeObserver;
  private destroyed = false;

  constructor(private o: ControllerOptions) {
    this.stage = o.stage;
    this.item = o.item;
    this.mpp = o.mpp;
    this.objective = o.objective;
    this.imageW = o.asset.width ?? 1;
    this.imageH = o.asset.height ?? 1;

    const navW = 220;
    this.viewer = OpenSeadragon({
      element: o.host,
      tileSources: assetUrl(viewPath(o.asset)),
      // OSD 6: WebGL where available, canvas otherwise.
      drawer: "auto",
      showNavigationControl: false,
      showNavigator: o.showNavigator,
      navigatorPosition: "BOTTOM_RIGHT",
      navigatorAutoFade: false,
      navigatorRotate: true,
      // Fixed size: a ratio is computed before the resizable panel has laid out.
      navigatorWidth: `${navW}px`,
      navigatorHeight: `${Math.max(60, Math.round((navW * this.imageH) / this.imageW))}px`,
      navigatorBackground: "#121215",
      navigatorBorderColor: "rgba(255,255,255,0.15)",
      navigatorDisplayRegionColor: resolveToken("--primary"),
      visibilityRatio: 0.5,
      minZoomImageRatio: 0.5,
      maxZoomPixelRatio: 2,
      gestureSettingsMouse: { clickToZoom: false, dblClickToZoom: false },
      gestureSettingsTouch: { pinchRotate: false },
      // Studio owns the keyboard (R/F/arrow keys are tool & navigation shortcuts).
      keyboardNavEnabled: false,
      animationTime: 0.4,
      crossOriginPolicy: false,
    });

    this.engine = new OverlayEngine({
      stage: o.stage,
      layerParent: this.viewer.canvas,
      itemId: o.item.id,
      view: this.view,
      labels: o.labels,
      units: micronUnits(o.mpp),
      tools: { wand: wandTool((p, shift, alt, ctx) => this.runWand(p, shift, alt, ctx)) },
      // Only the slide surface: panels, buttons and the navigator handle their own clicks.
      accepts: (t) => t instanceof Node && this.viewer.canvas.contains(t),
      hostClicks: true,
      reveal: (bb) => this.reveal(bb),
      onState: ({ hint, busy }) => this.setUi({ hint, busy }),
    });

    this.viewer.addHandler("open", () => {
      const src = this.viewer.world.getItemAt(0)?.source;
      if (src?.dimensions) {
        this.imageW = src.dimensions.x;
        this.imageH = src.dimensions.y;
      }
      this.setUi({ ready: true, drawer: this.viewer.drawer?.getType?.() ?? "" });
      this.syncView();
      this.engine.setReady();
    });
    // OSD's own open-failed box prints the tile source as "[object Object]"; the Studio shows the error.
    (this.viewer as unknown as { _showMessage: (m: string) => void })._showMessage = () => {};
    this.viewer.addHandler("open-failed", () => this.setUi({ error: "This slide's tile pyramid could not be opened." }));
    // todo18: missing tiles are one error, not holes in the slide.
    let tileErrors = 0;
    this.viewer.addHandler("tile-load-failed", () => {
      tileErrors += 1;
      if (tileErrors === 1) this.setUi({ error: tileErrorText(tileErrors) });
    });
    // Fires inside OSD's animation frame, before tiles are drawn: redraw synchronously so overlays never lag.
    this.viewer.addHandler("update-viewport", () => {
      this.syncView();
      this.engine.drawNow();
    });
    this.viewer.addHandler("resize", () => this.resize());
    // OSD handled the press (pan); a quick click on empty slide clears the selection.
    this.viewer.addHandler("canvas-click", (e) => this.engine.emptyClick(e.quick));

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(o.stage);
    this.resize();
  }

  destroy() {
    this.destroyed = true;
    this.resizeObserver.disconnect();
    this.engine.destroy();
    this.viewer.destroy();
  }

  // Read by the e2e tests and the dev console (window.__pathology).
  get scene() {
    return this.engine.scene;
  }
  get bulk() {
    return this.engine.bulk;
  }
  get dpr() {
    return this.engine.dpr;
  }
  get lastStats() {
    return this.engine.lastStats;
  }

  private setUi(patch: Partial<UiState>) {
    const next = { ...this.ui, ...patch };
    if ((Object.keys(next) as (keyof UiState)[]).every((k) => next[k] === this.ui[k])) return;
    this.ui = next;
    this.o.onUi(next);
  }

  private syncView() {
    if (!this.viewer.world.getItemCount()) return;
    syncViewFromOSD(this.view, this.viewer, this.imageW, this.imageH);
    const mag = Math.round(this.view.scale * this.objective * 100) / 100;
    this.setUi({ mag, rotation: this.viewer.viewport.getRotation(), flipped: this.viewer.viewport.getFlip() });
  }

  private resize() {
    this.engine.resize(this.stage.clientWidth, this.stage.clientHeight);
    this.syncView();
    this.engine.drawNow();
  }

  /** Pan (or zoom out) so an image-space bbox is on screen. */
  private reveal([x0, y0, x1, y1]: [number, number, number, number]) {
    const v = this.view;
    const vp = this.viewer.viewport;
    const w = (x1 - x0) * v.scale, h = (y1 - y0) * v.scale;
    if (w < v.width * 0.8 && h < v.height * 0.8) {
      vp.panTo(vp.imageToViewportCoordinates(new OpenSeadragon.Point((x0 + x1) / 2, (y0 + y1) / 2)));
    } else {
      const pad = Math.max(x1 - x0, y1 - y0) * 0.1;
      vp.fitBoundsWithConstraints(vp.imageToViewportRectangle(x0 - pad, y0 - pad, x1 - x0 + 2 * pad, y1 - y0 + 2 * pad));
    }
  }

  // ------------------------------------------------------------------ view actions

  /** Dev self-check: synthetic objects (not saved) → index build/query and frame timings at the current view. */
  async selfCheck(marks = 50_000, regions = 2_000) {
    const perf = await import("./perf");
    const list = perf.syntheticAnnotations(marks, regions, this.imageW, this.imageH);
    const index = perf.benchIndex(list, this.imageW, this.imageH);
    const frames = perf.benchFrames(list, this.view);
    console.table({ ...index, queryMs: index.queryMs.map((t) => t.toFixed(3)).join(" / "), queryHits: index.queryHits.join(" / ") });
    console.table({ meanFrameMs: frames.mean.toFixed(2), maxFrameMs: frames.max.toFixed(2), ...frames.stats });
    return { index, frames };
  }

  zoomToMagnification(mag: number) {
    const vp = this.viewer.viewport;
    vp.zoomTo(vp.imageToViewportZoom(mag / this.objective));
  }
  zoomBy(f: number) {
    this.viewer.viewport.zoomBy(f);
  }
  goHome() {
    this.viewer.viewport.goHome();
  }
  rotate(delta: number) {
    const vp = this.viewer.viewport;
    vp.setRotation((((vp.getRotation() + delta) % 360) + 360) % 360);
  }
  resetRotation() {
    this.viewer.viewport.setRotation(0);
    this.viewer.viewport.setFlip(false);
  }
  toggleFlip() {
    this.viewer.viewport.toggleFlip();
  }
  toggleNames() {
    this.setUi({ showNames: !this.ui.showNames });
    this.engine.setShowNames(this.ui.showNames);
  }
  setAdjust(adj: Adjustments, gammaFilterId: string) {
    this.adjust = adj;
    const parts: string[] = [];
    if (adj.brightness !== 1) parts.push(`brightness(${adj.brightness})`);
    if (adj.contrast !== 1) parts.push(`contrast(${adj.contrast})`);
    if (adj.saturation !== 1) parts.push(`saturate(${adj.saturation})`);
    if (adj.gamma !== 1) parts.push(`url(#${gammaFilterId})`);
    // Filter the tile canvas only, so overlays keep their true label colours.
    this.viewer.drawer.canvas.style.filter = parts.join(" ");
  }

  // ------------------------------------------------------------------ wand (pixel access)

  private async runWand(p: Pt, shift: boolean, alt: boolean, ctx: ToolContext) {
    ctx.setBusy(true);
    const itemId = this.item.id;
    try {
      const tolerance = toolOption(ctx.store(), "wand", "tolerance", 28);
      const region = await wandRegion(this.viewer, this.view, p, tolerance, this.adjust);
      this.wandRunner = lastWandRunner;
      if (this.destroyed || this.item.id !== itemId || !region.length) return;
      const s = ctx.store();
      const sel = ctx.selected();
      const target = sel && sel.kind === "region" && ctx.editable(sel.a) && (alt || sel.a.label === s.activeLabel) && (shift || alt) ? sel.a.id : null;
      ctx.applyRegion(region, alt ? "subtract" : "add", target);
    } catch (err) {
      console.warn("[wsi] wand failed", err);
    } finally {
      ctx.setBusy(false);
    }
  }
}

/** One message for missing tiles (todo18 §2 C). */
export function tileErrorText(n: number): string {
  return n === 1 ? "Some tiles of this slide are missing (the pyramid is incomplete)." : `${n} tiles of this slide are missing (the pyramid is incomplete).`;
}
