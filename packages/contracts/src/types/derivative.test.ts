import { describe, expect, it } from "vitest";
import { derivativeNotice, viewPath } from "./index";

describe("todo18 derivatives", () => {
  it("opens the derivative when ready, the file otherwise", () => {
    expect(viewPath({ path: "u/p/a.avi" })).toBe("u/p/a.avi");
    expect(viewPath({ path: "u/p/a.avi", derivative: { kind: "video-mp4", state: "processing", progress: 3 } })).toBe("u/p/a.avi");
    expect(viewPath({ path: "u/p/a.avi", derivative: { kind: "video-mp4", state: "ready", src: "u/p/derived/x.mp4" } })).toBe("u/p/derived/x.mp4");
  });
  it("shows Converting video / Preparing slide (n %) / the failure reason", () => {
    expect(derivativeNotice({ derivative: { kind: "video-mp4", state: "processing", label: "Converting video" } })).toEqual({ busy: true, text: "Converting video…" });
    // todo19: a video shows n % once the worker reports progress.
    expect(derivativeNotice({ derivative: { kind: "video-mp4", state: "processing", progress: 12.4 } })).toEqual({ busy: true, text: "Converting video (12 %)" });
    expect(derivativeNotice({ derivative: { kind: "slide-dzi", state: "processing", progress: 41.6, label: "Preparing slide" } })).toEqual({ busy: true, text: "Preparing slide (42 %)" });
    expect(derivativeNotice({ derivative: { kind: "video-mp4", state: "failed", error: "ffmpeg can't decode cinepak video" } })?.text).toContain("cinepak");
    expect(derivativeNotice({ derivative: { kind: "video-mp4", state: "ready", src: "x" } })).toBeNull();
    expect(derivativeNotice({})).toBeNull();
  });
});
