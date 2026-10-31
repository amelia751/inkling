import { describe, expect, it } from "vitest";
import "@/extension-host/bundled";
import { labelGroupsFrom } from "@/studio/lib/api";
import { registry } from "@/extension-host/registry";
import { resolveEnvironment } from "@/extension-host/resolve";
import { toolbarLayout } from "./toolbar-layout";

/** What the toolbar shows: `name` for an expanded tool, `name▾` for a split button's face. */
const faces = (id: string, labels = labelGroupsFrom(["a", "b"]), active?: string, lastUsed?: Record<string, string>) => {
  const env = resolveEnvironment({ extends: `preset:${id}`, labels }, registry).env!;
  return toolbarLayout(env.tools, active, lastUsed)
    .map((s) => (s.kind === "fold" ? `${s.face.name}▾` : s.tools.map((t) => t.name).join(" · ")))
    .join(" | ");
};

describe("toolbar layout (todo8 D4 Rule 2)", () => {
  it("folds image-2d into Select · Pan · W/L | Box▾ | Length▾ | Brush▾", () => {
    expect(faces("image-2d")).toBe("select · pan · windowLevel | box▾ | length▾ | brush▾");
  });

  it("leaves a classification task with navigation and the measure group", () => {
    expect(faces("image-2d", labelGroupsFrom(["normal", "pneumonia"], "classification"))).toBe("select · pan · windowLevel | length▾");
  });

  it("shows the active tool, else the group's last used one, as the face", () => {
    expect(faces("image-2d", undefined, "cobb")).toBe("select · pan · windowLevel | box▾ | cobb▾ | brush▾");
    expect(faces("image-2d", undefined, "select", { shape: "polygon", mask: "eraser" })).toBe("select · pan · windowLevel | polygon▾ | length▾ | eraser▾");
    // A remembered tool this environment doesn't offer is ignored.
    expect(faces("image-2d", undefined, "select", { shape: "spline" })).toBe("select · pan · windowLevel | box▾ | length▾ | brush▾");
  });

  it("shows Zoom only while it is the active tool", () => {
    expect(faces("image-2d", undefined, "zoom")).toBe("select · pan · zoom · windowLevel | box▾ | length▾ | brush▾");
  });

  it("keeps groups of one or two tools expanded", () => {
    expect(faces("pathology")).toBe("select · pan | box▾ | brush▾ | length");
    expect(faces("volume-3d")).toBe("select · pan · windowLevel · crosshairs | brush▾ | point▾ | length▾");
  });
});
