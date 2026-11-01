import { describe, expect, it } from "vitest";
import { filesRedirect, filesUrl, projectUrl, sourcesUrl, targetUrl, trashUrl } from "./routes";

describe("targetUrl (todo6 Phase 8: every review row and activity link opens its exact surface)", () => {
  const p = "prj-1";
  it.each([
    // "sources" and the old "files" targets (stored in activity and attention rows) open the Sources URL.
    [{ section: "sources", nodeId: "n1" }, "/projects/prj-1/sources/n1"],
    [{ section: "sources", importId: "imp-1" }, "/projects/prj-1/sources?import=imp-1"],
    [{ section: "sources", status: "unsupported", nodeId: "n2" }, "/projects/prj-1/sources/n2?status=unsupported"],
    [{ section: "files", nodeId: "nod-1" }, "/projects/prj-1/sources/nod-1"],
    [{ section: "files", tab: "trash" }, "/projects/prj-1/sources/trash"],
    [{ section: "files" }, "/projects/prj-1/sources"],
    [{ section: "explore", tab: "relationships", proposalId: "prp-1" }, "/projects/prj-1/explore/relationships?proposal=prp-1"],
    [{ section: "datasets", datasetId: "ds-1", tab: "versions", reviewId: "rv-1" }, "/projects/prj-1/datasets/ds-1/versions/reviews/rv-1"],
    [{ section: "datasets", datasetId: "ds-1", tab: "versions" }, "/projects/prj-1/datasets/ds-1/versions"],
    [{ section: "datasets", datasetId: "ds-1" }, "/projects/prj-1/datasets/ds-1"],
    [{ section: "datasets", datasetId: "ds-1", tab: "quality" }, "/projects/prj-1/datasets/ds-1/quality"],
    [{ section: "datasets", datasetId: "ds-1", tab: "fields" }, "/projects/prj-1/datasets/ds-1/fields"],
    [{ section: "datasets", datasetId: "ds-1", tab: "nonsense" }, "/projects/prj-1/datasets/ds-1"],
    [{ section: "studio", taskId: "tsk-1" }, "/projects/prj-1/studio/tsk-1"],
    [{ section: "settings" }, "/projects/prj-1/settings/general"],
    [{ section: "settings", tab: "plugins" }, "/projects/prj-1/settings/plugins"],
  ])("%j → %s", (t, url) => expect(targetUrl(p, t)).toBe(url));
});

describe("Sources URLs", () => {
  it("names the section sources; files is an alias", () => {
    expect(projectUrl("p", "sources")).toBe("/projects/p/sources");
    expect(projectUrl("p", "files")).toBe("/projects/p/sources");
    expect(sourcesUrl("p", "seq:a:b")).toBe(filesUrl("p", "seq:a:b"));
    expect(filesUrl("p", "seq:a:b", { q: "x" })).toBe("/projects/p/sources/seq%3Aa%3Ab?q=x");
    expect(trashUrl("p")).toBe("/projects/p/sources/trash");
  });

  it.each([
    ["/projects/p/files", "", "/projects/p/sources"],
    ["/projects/p/files/n1", "?import=imp-1", "/projects/p/sources/n1?import=imp-1"],
    ["/projects/p/files/seq%3Aa%3Ab", "?status=held", "/projects/p/sources/seq%3Aa%3Ab?status=held"],
  ])("redirects %s%s", (path, search, to) => expect(filesRedirect(path, search)).toBe(to));
});
