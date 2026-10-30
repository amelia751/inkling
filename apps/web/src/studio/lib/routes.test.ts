import { describe, expect, it } from "vitest";
import { targetUrl } from "./routes";

describe("targetUrl (todo6 Phase 8: every review row and activity link opens its exact surface)", () => {
  const p = "prj-1";
  it.each([
    [{ section: "sources", nodeId: "n1" }, "/projects/prj-1/sources/n1"],
    [{ section: "sources", importId: "imp-1" }, "/projects/prj-1/sources?import=imp-1"],
    [{ section: "sources", status: "unsupported", nodeId: "n2" }, "/projects/prj-1/sources/n2?status=unsupported"],
    [{ section: "explore", tab: "relationships", proposalId: "prp-1" }, "/projects/prj-1/explore/relationships?proposal=prp-1"],
    [{ section: "datasets", datasetId: "ds-1", tab: "versions", reviewId: "rv-1" }, "/projects/prj-1/datasets/ds-1/versions/reviews/rv-1"],
    [{ section: "datasets", datasetId: "ds-1", tab: "versions" }, "/projects/prj-1/datasets/ds-1/versions"],
    [{ section: "datasets", datasetId: "ds-1" }, "/projects/prj-1/datasets/ds-1"],
    [{ section: "studio", taskId: "tsk-1" }, "/projects/prj-1/studio/tsk-1"],
    [{ section: "settings" }, "/projects/prj-1/settings/general"],
    [{ section: "settings", tab: "plugins" }, "/projects/prj-1/settings/plugins"],
  ])("%j → %s", (t, url) => expect(targetUrl(p, t)).toBe(url));
});
