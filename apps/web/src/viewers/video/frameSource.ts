import type { CanvasSink, Input, InputVideoTrack } from "mediabunny";

type FrameCanvas = HTMLCanvasElement | OffscreenCanvas;

/**
 * Frame-exact decoding for paused / stepping / scrubbing (WebCodecs via mediabunny).
 * `<video>` seeking lands on "a frame near t", which with B-frames and imprecise
 * `currentTime` is often off by one; here every frame index maps to its own
 * presentation timestamp (read once from the container's sample table) and is decoded
 * exactly. Decoded frames sit in a small LRU; neighbours are prefetched in batches so
 * stepping either way stays instant.
 */
export class FrameSource {
  /** Presentation timestamps (s) of every frame, ascending. Frame i starts at timestamps[i]. */
  timestamps: number[] = [];
  width = 0;
  height = 0;
  /** Called whenever a frame finishes decoding (the viewer presents it if it is still wanted). */
  onFrame: (frame: number, canvas: FrameCanvas) => void = () => {};
  onError: (error: unknown) => void = () => {};

  private input: Input | null = null;
  private track: InputVideoTrack | null = null;
  private sink: CanvasSink | null = null;
  private thumbSink: CanvasSink | null = null;
  private cache = new Map<number, FrameCanvas>();
  private capacity = 48;
  private wanted: number | null = null;
  private running = false;
  private disposed = false;
  private thumbs = new Map<number, FrameCanvas>();
  private thumbGen = 0;

  constructor(private url: string) {}

  get frameCount() {
    return this.timestamps.length;
  }

  /** Probe, index and verify decoding. Throws with a human-readable reason when exact mode isn't possible. */
  async open(): Promise<void> {
    if (typeof VideoDecoder === "undefined") throw new Error("WebCodecs is not available in this browser");
    const mb = await import("mediabunny");
    this.input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.UrlSource(this.url) });
    const track = await this.input.getPrimaryVideoTrack();
    if (!track) throw new Error("no video track found");
    if (!(await track.canDecode())) throw new Error(`codec ${track.codec ?? "unknown"} cannot be decoded with WebCodecs`);
    this.track = track;
    this.width = track.displayWidth;
    this.height = track.displayHeight;

    // Frame-timestamp index from packet metadata only (no media bytes are read).
    const packets = new mb.EncodedPacketSink(track);
    const ts: number[] = [];
    let p = await packets.getFirstPacket({ metadataOnly: true });
    while (p) {
      if (this.disposed) return;
      ts.push(p.timestamp);
      p = await packets.getNextPacket(p, { metadataOnly: true });
    }
    if (!ts.length) throw new Error("the video has no frames");
    this.timestamps = ts.sort((a, b) => a - b);

    // ~96 MB of decoded RGBA, at least a GOP-ish window either side.
    this.capacity = Math.max(16, Math.min(150, Math.floor(24e6 / Math.max(1, this.width * this.height))));
    this.sink = new mb.CanvasSink(track, { poolSize: 0 });
    // Prove the decoder works before committing to exact mode.
    const first = await this.sink.getCanvas(this.at(0));
    if (!first) throw new Error("the first frame could not be decoded");
    this.put(0, first.canvas);
  }

  /** Timestamp to ask the decoder for frame i (a hair past its start, robust to float noise). */
  private at(i: number) {
    return this.timestamps[i] + 1e-6;
  }

  /** Frame index presented at media time `t` (seconds on the container's timeline). */
  frameAt(t: number): number {
    const ts = this.timestamps;
    let lo = 0, hi = ts.length - 1;
    if (t < ts[0]) return 0;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ts[mid] <= t + 1e-4) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  get(frame: number): FrameCanvas | undefined {
    const c = this.cache.get(frame);
    if (c) {
      this.cache.delete(frame);
      this.cache.set(frame, c);
    }
    return c;
  }

  /** Ask for a frame; the newest request wins. Resolution arrives through `onFrame`. */
  request(frame: number) {
    if (this.disposed || !this.sink) return;
    this.wanted = Math.max(0, Math.min(this.frameCount - 1, frame));
    void this.pump();
  }

  private put(frame: number, canvas: FrameCanvas) {
    this.cache.delete(frame);
    this.cache.set(frame, canvas);
    while (this.cache.size > this.capacity) this.cache.delete(this.cache.keys().next().value!);
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.wanted !== null && !this.disposed) {
        const f = this.wanted;
        this.wanted = null;
        const hit = this.get(f);
        if (hit) this.onFrame(f, hit);
        // Target first, then the frames ahead (stepping forward / play-from-here).
        const ahead = Math.floor(Math.min(24, Math.max(8, this.capacity / 4)));
        const fwd = [f, ...range(f + 1, Math.min(this.frameCount, f + 1 + ahead))].filter((i, k) => (k === 0 ? !hit : !this.cache.has(i)));
        if (!(await this.decode(fwd, true))) continue;
        // Then behind (stepping back re-decodes from the keyframe, so batch it).
        const behind = range(Math.max(0, f - Math.floor(Math.min(16, this.capacity / 4))), f).filter((i) => !this.cache.has(i));
        await this.decode(behind, false);
      }
    } catch (e) {
      if (!this.disposed) this.onError(e);
    } finally {
      this.running = false;
    }
  }

  /** Decode `frames` (ascending) in one pass; stop early when a newer request arrives. Returns false if interrupted. */
  private async decode(frames: number[], notifyFirst: boolean): Promise<boolean> {
    if (!frames.length || !this.sink) return true;
    let k = 0;
    for await (const wc of this.sink.canvasesAtTimestamps(frames.map((i) => this.at(i)))) {
      if (this.disposed) return false;
      const f = frames[k++];
      if (wc) {
        this.put(f, wc.canvas);
        if (k === 1 && notifyFirst) this.onFrame(f, wc.canvas);
      }
      if (this.wanted !== null) return false;
    }
    return true;
  }

  getThumb(frame: number): FrameCanvas | undefined {
    return this.thumbs.get(frame);
  }

  /** Low-res thumbnails for the filmstrip; a newer call cancels an older one. */
  async loadThumbs(frames: number[], width: number, onThumb: () => void) {
    if (!this.track || this.disposed) return;
    const gen = ++this.thumbGen;
    const want = [...new Set(frames)].filter((f) => !this.thumbs.has(f)).sort((a, b) => a - b);
    if (!want.length) return;
    if (!this.thumbSink) {
      const mb = await import("mediabunny");
      this.thumbSink = new mb.CanvasSink(this.track, { width, poolSize: 0 });
    }
    let k = 0;
    try {
      for await (const wc of this.thumbSink.canvasesAtTimestamps(want.map((i) => this.at(i)))) {
        if (gen !== this.thumbGen || this.disposed) return;
        const f = want[k++];
        if (wc) {
          this.thumbs.set(f, wc.canvas);
          if (this.thumbs.size > 600) this.thumbs.delete(this.thumbs.keys().next().value!);
          onThumb();
        }
      }
    } catch {
      // Thumbnails are a nicety; the main decoder reports real failures.
    }
  }

  dispose() {
    this.disposed = true;
    this.cache.clear();
    this.thumbs.clear();
    this.input?.dispose();
  }
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i < to; i++) out.push(i);
  return out;
}
