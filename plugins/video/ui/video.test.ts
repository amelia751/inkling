import { describe, expect, it } from "vitest";
import "@/extension-host/bundled";
import { shapeUtil } from "@studio/renderers/overlay2d/shapes";
import { migrateAnnotation } from "@studio/contracts/migrations/annotations-v1-to-v2";
import { registry } from "@/extension-host/registry";
import { resolveEnvironment } from "@/extension-host/resolve";
import type { RuntimeApi } from "@studio/plugin-ui-sdk/module";
import type { Annotation, Geometry, Project, StudioItem } from "@studio/contracts/types";
import { videoExporters } from "./exporters";
import { describeInstant, describeSpan, describeTrack } from "./geometries";
import { inspectVideo } from "./inspect";
import { placeTrack, registerTrackShape, resolveTrack, unplace } from "./trackShape";
import { shapeAt, toggleOccluded, toggleOutside, trackSpans, type TrackGeometry } from "./tracks";
import { ns } from "@studio/contracts/naming";

registerTrackShape();

const box = (frame: number, b: [number, number, number, number], extra = {}) => ({ frame, box: b, ...extra });
const TRACK: TrackGeometry = { type: "track", shape: "box", keyframes: [box(0, [0, 0, 10, 10]), box(10, [100, 0, 20, 10])] };

const ann = (id: string, geometry: Geometry, extra: Partial<Annotation> = {}): Annotation => ({
  id,
  itemId: "v.mp4",
  label: "polyp",
  geometry,
  author: "t",
  provenance: "human",
  createdAt: `2026-01-01T00:00:0${id.length}Z`,
  updatedAt: "2026-01-01T00:00:00Z",
  ...extra,
}) as Annotation;

const item: StudioItem = { id: "v.mp4", name: "v.mp4", group: "Videos", dataKind: ns("video.dataKinds.video"), assets: [{ path: "video/v.mp4", fps: 25, frames: 50, width: 64, height: 48 } as StudioItem["assets"][number]] };
const project = { id: "vid", title: "Videos", labels: [{ name: "classes", control: "Labels", classes: [{ id: "polyp" }, { id: "bleeding" }] }], assets: item.assets } as unknown as Project;

describe("tracks", () => {
  it("interpolates between keyframes and holds after the last", () => {
    expect(shapeAt(TRACK, 5)!.box).toEqual([50, 0, 15, 10]);
    expect(shapeAt(TRACK, 30)!.box).toEqual([100, 0, 20, 10]);
    expect(shapeAt(TRACK, 5)!.keyframe).toBe(false);
  });

  it("outside hides until the next keyframe; occluded marks the span", () => {
    const out = toggleOutside(TRACK, 4);
    expect(shapeAt(out, 6)).toBeNull();
    expect(shapeAt(out, 10)).not.toBeNull();
    const occ = toggleOccluded(TRACK, 2);
    expect(shapeAt(occ, 5)!.occluded).toBe(true);
    expect(trackSpans(occ, 20)).toEqual([{ start: 0, end: 2, occluded: false }, { start: 2, end: 10, occluded: true }, { start: 10, end: 20, occluded: false }]);
  });
});

describe("track ShapeUtil (resolved at the playhead)", () => {
  it("is registered and resolves the interpolated shape at its placement", () => {
    const placed = placeTrack(TRACK, 5);
    const u = shapeUtil(placed)!;
    expect(u).toBeDefined();
    expect(resolveTrack(placed)).toEqual({ type: "box", x: 50, y: 0, w: 15, h: 10 });
    expect(u.bounds(placed)).toEqual([50, 0, 65, 10]);
    expect(u.handles(placed)[4]).toEqual([65, 10]);
  });

  it("hit-tests the shape on its frame only", () => {
    const id = (x: number, y: number) => [x, y] as [number, number];
    expect(shapeUtil(placeTrack(TRACK, 5))!.hitTest(placeTrack(TRACK, 5), [55, 5], id)).toEqual({ part: "body" });
    expect(shapeUtil(placeTrack(TRACK, 0))!.hitTest(placeTrack(TRACK, 0), [55, 5], id)).toBeNull();
  });

  it("writes edits as a keyframe on the placed frame", () => {
    const placed = placeTrack(TRACK, 5);
    const moved = unplace(shapeUtil(placed)!.translate(placed, 1, 2)) as TrackGeometry;
    expect("at" in moved).toBe(false);
    expect(moved.keyframes.map((k) => k.frame)).toEqual([0, 5, 10]);
    expect(moved.keyframes[1].box).toEqual([51, 2, 15, 10]);
    const resized = unplace(shapeUtil(placed)!.applyHandle(placed, 4, [70, 20])) as TrackGeometry;
    expect(resized.keyframes[1].box).toEqual([50, 0, 20, 20]);
  });

  it("leaves a track alone where it is outside", () => {
    const out = placeTrack(toggleOutside(TRACK, 4), 6);
    expect(shapeUtil(out)!.translate(out, 5, 5)).toBe(out);
  });
});

describe("geometries", () => {
  it("describes video spans, events and tracks", () => {
    expect(describeSpan({ type: "span", start: 1, end: 2.5 })).toBe("Segment 1.00–2.50s · 1.50 s");
    expect(describeInstant({ type: "instant", frame: 9 })).toBe("Event · frame 10");
    expect(describeTrack(TRACK, ann("a", TRACK, { attributes: { trackId: 3 } }))).toBe("Track #3 (box) · 2 keyframes · frames 1–11");
  });

  it("the video preset resolves with the video geometry refinements", () => {
    const { env, errors } = resolveEnvironment({ extends: "preset:video" }, registry);
    expect(errors).toBeUndefined();
    expect(env!.geometries.filter((g) => g.id.startsWith(ns("video."))).map((g) => g.type)).toEqual(["span", "instant", "track"]);
  });
});

describe("inspector", () => {
  const runtime = (values: Record<string, unknown>): RuntimeApi => ({ publish: () => {}, get: <T,>(k: string) => values[k] as T });
  const ctx = (values: Record<string, unknown>) => ({ env: null as never, project, item, runtime: runtime(values) });

  it("reads the playhead from the runtime", () => {
    const a = ann("a", TRACK, { attributes: { trackId: 1 } });
    expect(inspectVideo(a, ctx({ playhead: { frame: 5, time: 0.2 } })).at(-1)).toEqual(["At frame 6", "15 px × 10 px"]);
    expect(inspectVideo(a, ctx({})).some(([k]) => k.startsWith("At frame"))).toBe(false);
  });

  it("shows spans and instants in frames and seconds", () => {
    expect(inspectVideo(ann("s", { type: "span", start: 0.4, end: 1 }), ctx({}))[2]).toEqual(["Duration", "0.60 s · 15 frames"]);
    expect(inspectVideo(ann("e", { type: "instant", frame: 25 }), ctx({}))).toEqual([["Frame", "26"], ["Time", "00:01.00"]]);
  });
});

describe("exporters", () => {
  // v1 documents (segment / event) migrate on load; the export of the migrated data must
  // match what the v1 exporter wrote for the same annotations.
  const v1 = [
    ann("seg", { type: "segment", start: 0.4, end: 1.2 } as Geometry),
    ann("ev", { type: "event", frame: 30 } as Geometry, { label: "bleeding" }),
    ann("trk", TRACK, { attributes: { trackId: 1 } }),
  ];
  const v2 = v1.map((a) => migrateAnnotation(a));
  const build = async (id: string, annotations: Annotation[]) => {
    const blob = await videoExporters[id].build({ project, items: [item], annotations });
    return new Uint8Array(await blob.arrayBuffer());
  };

  it("temporal JSON lists spans as segments and instants as events", async () => {
    const doc = JSON.parse(new TextDecoder().decode(await build("temporal-json", v2)));
    const vid = doc.videos[0];
    expect(vid.segments).toEqual([{ id: "seg", label: "polyp", start: 0.4, end: 1.2, duration: 0.8, startFrame: 10, endFrame: 29, provenance: "human", attributes: {} }]);
    expect(vid.events).toEqual([{ id: "ev", label: "bleeding", frame: 30, time: 1.2, provenance: "human", attributes: {} }]);
    const keys = Object.keys(doc);
    expect(keys).toEqual(["format", "version", "project", "exportedAt", "note", "videos"]);
  });

  it("MOT rows come from box tracks (1-based frames)", async () => {
    const zipBytes = await build("mot", v2);
    const text = new TextDecoder("latin1").decode(zipBytes);
    expect(text).toContain("1,1,0.00,0.00,10.00,10.00,1,1,1");
    expect(text).toContain("seqLength=50");
  });
});
