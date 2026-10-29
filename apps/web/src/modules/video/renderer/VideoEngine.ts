import { flushSync } from "react-dom";
import { FrameSource } from "@/kits/io/frameSource";

/**
 * Frame source and playback clock for one video (no React state): frame-exact decoding
 * through WebCodecs when available, else seeking the `<video>` element; playback follows
 * the presented frame through requestVideoFrameCallback; an optional A–B range and loop.
 * The host subscribes (`subscribe` / `getState`, for useSyncExternalStore) and attaches
 * the `<video>` and frame canvas it renders.
 */

export type DecodeMode = "loading" | "exact" | "video";

export interface VideoState {
  mode: DecodeMode;
  fallbackReason: string | null;
  videoReady: boolean;
  clockReady: boolean;
  error: string | null;
  frames: number;
  dims: { width: number; height: number };
  /** Frame on screen (overlays and edits use this). */
  frame: number;
  /** Frame asked for (playhead, readout). */
  target: number;
  playing: boolean;
  rate: number;
  loop: boolean;
  range: { a: number; b: number } | null;
  /** Bumps when filmstrip thumbnails arrive. */
  thumbVersion: number;
}

export interface VideoAsset {
  url: string;
  fps: number;
  frames?: number;
  duration?: number;
  width?: number;
  height?: number;
}

export class VideoEngine {
  readonly fps: number;
  private s: VideoState;
  private listeners = new Set<() => void>();
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private source: FrameSource | null = null;
  private playing = false;
  private target = 0;
  private lastPresented = 0;
  private seekAfterPause: number | null = null;
  private shownCanvas: unknown = null;
  /** Element time at which frame 0 is presented (calibrated from requestVideoFrameCallback). */
  private clock = { base: 0, calibrated: false, ready: false };
  private videoSeekFrame: number | null = null;
  private stopLoop: (() => void) | null = null;
  private calibrating = false;

  constructor(private asset: VideoAsset) {
    this.fps = asset.fps;
    this.s = {
      mode: "loading",
      fallbackReason: null,
      videoReady: false,
      clockReady: false,
      error: null,
      frames: Math.max(1, asset.frames ?? Math.round((asset.duration ?? 0) * asset.fps)),
      dims: { width: asset.width ?? 0, height: asset.height ?? 0 },
      frame: 0,
      target: 0,
      playing: false,
      rate: 1,
      loop: false,
      range: null,
      thumbVersion: 0,
    };
  }

  // ---- store ----
  getState = () => this.s;
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };
  /** `sync`: commit the render before returning, so the frame and its overlays share a paint. */
  private set(patch: Partial<VideoState>, sync = false) {
    this.s = { ...this.s, ...patch };
    const emit = () => this.listeners.forEach((l) => l());
    if (sync) flushSync(emit);
    else emit();
  }

  get ready() {
    return this.s.mode === "exact" || (this.s.videoReady && this.s.clockReady);
  }

  // ---- time mapping ----
  /** Seconds from frame 0's start to frame f's start. */
  private relTime(f: number) {
    const s = this.source;
    return s?.frameCount ? s.timestamps[Math.min(f, s.frameCount - 1)] - s.timestamps[0] : f / this.fps;
  }
  /** Where to put `<video>.currentTime` so frame f is presented (a quarter frame in, away from boundaries). */
  private videoTimeOf(f: number) {
    return this.clock.base + this.relTime(f) + 0.25 / this.fps;
  }
  private frameOfMediaTime(t: number) {
    const s = this.source;
    const rel = t - this.clock.base;
    const f = s?.frameCount ? s.frameAt(rel + s.timestamps[0]) : Math.round(rel * this.fps);
    return Math.max(0, Math.min(this.s.frames - 1, f));
  }

  // ---- mounting ----
  /** Bind the rendered `<video>` and frame canvas and start decoding. Returns the detach function. */
  attach(video: HTMLVideoElement, canvas: HTMLCanvasElement): () => void {
    this.video = video;
    this.canvas = canvas;
    const on: [string, () => void][] = [
      ["loadedmetadata", this.onLoadedMetadata],
      ["loadeddata", this.onLoadedData],
      ["play", this.onPlay],
      ["pause", this.onPause],
      ["ended", this.onEnded],
      ["seeked", this.onSeeked],
      ["error", this.onError],
    ];
    on.forEach(([k, fn]) => video.addEventListener(k, fn));
    // Catch up on events that fired before the host attached.
    if (video.readyState >= 1) this.onLoadedMetadata();
    if (video.readyState >= 2) this.onLoadedData();
    const closeSource = this.openSource();
    return () => {
      closeSource();
      on.forEach(([k, fn]) => video.removeEventListener(k, fn));
      this.stopLoop?.();
      this.stopLoop = null;
    };
  }

  private openSource() {
    let alive = true;
    const src = new FrameSource(this.asset.url);
    this.source = src;
    src.onFrame = (f, canvas) => {
      if (alive && f === this.target && this.s.mode === "exact") this.present(f, canvas);
    };
    src.onError = (e) => alive && this.fallBack(`decoder error: ${e instanceof Error ? e.message : String(e)}`);
    src
      .open()
      .then(() => {
        if (!alive) return;
        if (!this.clock.calibrated) this.clock.base = src.timestamps[0];
        this.set({ frames: src.frameCount, mode: "exact", ...(src.width && src.height ? { dims: { width: src.width, height: src.height } } : {}) });
        if (this.playing) return;
        const c = src.get(this.target);
        if (c) this.present(this.target, c);
        src.request(this.target);
      })
      .catch((e) => alive && this.fallBack(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
      src.dispose();
      if (this.source === src) this.source = null;
    };
  }

  private showFrameCanvas(on: boolean) {
    if (this.canvas) this.canvas.style.visibility = on ? "visible" : "hidden";
  }

  /** Put a decoded frame on screen and move the overlays to it in the same paint. */
  private present(f: number, canvas: HTMLCanvasElement | OffscreenCanvas) {
    const fc = this.canvas;
    if (!fc || this.playing) return;
    if (this.shownCanvas !== canvas) {
      if (fc.width !== canvas.width || fc.height !== canvas.height) {
        fc.width = canvas.width;
        fc.height = canvas.height;
      }
      fc.getContext("2d")!.drawImage(canvas, 0, 0);
      this.shownCanvas = canvas;
    }
    this.showFrameCanvas(true);
    this.lastPresented = f;
    this.set({ frame: f }, true);
  }

  private fallBack(reason: string) {
    this.source?.dispose();
    this.source = null;
    this.showFrameCanvas(false);
    this.set({ fallbackReason: reason, mode: "video" });
    // Until the element's clock is known, finishClock() seeks to the target itself.
    const v = this.video;
    if (v && !this.playing && v.readyState >= 1 && this.clock.ready) {
      this.videoSeekFrame = this.target;
      v.currentTime = this.videoTimeOf(this.target);
    }
  }

  // ---- transport ----
  seek = (f: number) => {
    f = Math.max(0, Math.min(this.s.frames - 1, Math.round(f)));
    const v = this.video;
    if (this.playing) {
      this.seekAfterPause = f;
      v?.pause();
      return;
    }
    this.target = f;
    this.set({ target: f });
    const src = this.source;
    if (this.s.mode === "exact" && src) {
      const c = src.get(f);
      if (c) this.present(f, c);
      src.request(f);
    } else if (v && v.readyState >= 1 && this.clock.ready) {
      this.videoSeekFrame = f;
      v.currentTime = this.videoTimeOf(f);
    }
  };

  step = (d: number) => this.seek((this.playing ? this.lastPresented : this.target) + d);

  /** First or last frame, of the A–B range when one is set. */
  seekEnd = (end: "first" | "last") => {
    const r = this.s.range;
    this.seek(end === "first" ? (r ? r.a : 0) : r ? r.b : this.s.frames - 1);
  };

  play = () => {
    const v = this.video;
    if (!v || v.readyState < 2 || !this.clock.ready) return;
    const r = this.s.range;
    let start = this.target;
    if (r && (start < r.a || start >= r.b)) start = r.a;
    else if (!r && start >= this.s.frames - 1) start = 0;
    v.currentTime = this.videoTimeOf(start);
    v.playbackRate = this.s.rate;
    void v.play().catch(() => {});
  };

  pause = () => this.video?.pause();

  togglePlay = () => {
    if (this.playing) this.video?.pause();
    else this.play();
  };

  setRate = (rate: number) => {
    this.set({ rate });
    if (this.video) this.video.playbackRate = rate;
  };
  setLoop = (loop: boolean) => this.set({ loop });
  setRange = (range: VideoState["range"]) => this.set({ range });

  // ---- filmstrip ----
  thumb = (f: number) => this.source?.getThumb(f) as CanvasImageSource | undefined;
  loadThumbs = (frames: number[]) => void this.source?.loadThumbs(frames, 96, () => this.set({ thumbVersion: this.s.thumbVersion + 1 }));

  // ---- element events ----
  private onLoadedMetadata = () => {
    const v = this.video!;
    if (!this.s.dims.width && v.videoWidth) this.set({ dims: { width: v.videoWidth, height: v.videoHeight } });
    if (this.s.mode !== "exact" && !this.asset.frames && v.duration) this.set({ frames: Math.max(1, Math.round(v.duration * this.fps)) });
  };

  private onLoadedData = () => {
    this.set({ videoReady: true });
    const v = this.video;
    if (!v || this.clock.ready || this.calibrating) return;
    this.calibrating = true;
    if ("requestVideoFrameCallback" in v) void this.calibrate(v);
    else this.finishClock(null);
  };

  private onPlay = () => {
    this.playing = true;
    this.set({ playing: true });
    this.startLoop();
  };

  private onPause = () => {
    this.playing = false;
    this.stopLoop?.();
    this.stopLoop = null;
    this.set({ playing: false });
    const f = this.seekAfterPause ?? this.lastPresented;
    this.seekAfterPause = null;
    this.seek(f);
  };

  private onEnded = () => {
    if (this.s.loop && !this.s.range) queueMicrotask(this.play);
  };

  private onError = () => {
    this.set({ error: this.s.mode === "exact" ? "Playback is unavailable for this file; frame stepping still works." : "This video could not be played." });
  };

  private onSeeked = () => {
    const v = this.video;
    if (!v || this.videoSeekFrame === null || this.playing || this.s.mode === "exact") return;
    // Trust where the element actually is, not which request was last issued: a seek that
    // lands while a newer one is pending must not label the picture with the newer frame.
    const f = this.frameOfMediaTime(v.currentTime);
    if (f !== this.target) return;
    this.videoSeekFrame = null;
    this.lastPresented = f;
    // No requestVideoFrameCallback cross-check here: WebKit can deliver the previous frame's
    // metadata after a paused seek, which would relabel a correct picture.
    this.set({ frame: f }, true);
  };

  /** Playback: follow the presented frame exactly via requestVideoFrameCallback. */
  private startLoop() {
    this.stopLoop?.();
    const v = this.video;
    if (!v) return;
    let alive = true;
    let handle = 0;
    const rvfc = "requestVideoFrameCallback" in v;
    const schedule = () => {
      handle = rvfc ? v.requestVideoFrameCallback(tick) : requestAnimationFrame(() => tick(0));
    };
    const tick = (_now: number, md?: VideoFrameCallbackMetadata) => {
      if (!alive) return;
      const f = this.frameOfMediaTime(md ? md.mediaTime : v.currentTime);
      const r = this.s.range;
      const end = r ? r.b : this.s.frames - 1;
      const start = r ? r.a : 0;
      if (f > end || (r && f < start)) {
        if (this.s.loop) v.currentTime = this.videoTimeOf(start);
        else {
          this.seekAfterPause = end;
          v.pause();
          return;
        }
        schedule();
        return;
      }
      if (this.s.mode === "exact") this.showFrameCanvas(false);
      this.lastPresented = f;
      this.target = f;
      this.set({ frame: f, target: f }, true);
      if (f === end && r && !this.s.loop) {
        this.seekAfterPause = end;
        v.pause();
        return;
      }
      schedule();
    };
    schedule();
    this.stopLoop = () => {
      alive = false;
      if (rvfc) v.cancelVideoFrameCallback(handle);
      else cancelAnimationFrame(handle);
    };
  }

  /**
   * Learn where this browser puts frame 0 on the element timeline (engines treat MP4 edit
   * lists differently: Chrome and WebKit present these files' first frame at 0.04 s).
   * Seeking to 0 always presents frame 0, but WebKit skips the frame callback when the
   * element is already there, so step away first. Element seeks wait until this is done.
   */
  private async calibrate(v: HTMLVideoElement) {
    const presented = () =>
      new Promise<number | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), 2000);
        v.requestVideoFrameCallback((_n, md) => {
          clearTimeout(timer);
          resolve(md.mediaTime);
        });
      });
    let next = presented();
    v.currentTime = Math.min(0.5, (v.duration || 1) / 2);
    const mid = await next;
    if (mid === null) return this.finishClock(null);
    next = presented();
    v.currentTime = 0;
    const first = await next;
    if (first !== null) return this.finishClock(first);
    // WebKit presents nothing for times before the first frame (a leading empty edit). The
    // edit's length is what the duration has beyond the frames; snap it to `mid`'s frame grid.
    const est = Math.max(0, v.duration - this.s.frames / this.fps);
    this.finishClock(Math.max(0, mid - Math.round((mid - est) * this.fps) / this.fps));
  }

  /** Clock known (or given up on): element seeks may proceed; show the wanted frame. */
  private finishClock(base: number | null) {
    if (this.clock.ready) return;
    if (base !== null) {
      this.clock.base = base;
      this.clock.calibrated = true;
    }
    this.clock.ready = true;
    this.set({ clockReady: true });
    if (this.s.mode !== "exact" && !this.playing) this.seek(this.target);
  }
}
