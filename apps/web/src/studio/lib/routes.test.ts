import { describe, expect, it } from "vitest";
import { filesRedirect, filesUrl, projectUrl, sourcesUrl, targetUrl, trashUrl } from "./routes";

describe("targetUrl (todo6 Phase 8: every review row and activity link opens its exact surface)", () => {
  const p = "prj-1";
  it.each([
    // todo7 D11: "sources" targets (stored in activity and attention rows) open the Files URL.
    [{ section: "sources", nodeId: "n1" }, "/projects/prj-1/files/n1"],
    [{ section: "sources", importId: "imp-1" }, "/projects/prj-1/files?import=imp-1"],
    [{ section: "sources", status: "unsupported", nodeId: "n2" }, "/projects/prj-1/files/n2?status=unsupported"],
    [{ section: "files", nodeId: "nod-1" }, "/projects/prj-1/files/nod-1"],
    [{ section: "files", tab: "trash" }, "/projects/prj-1/files/trash"],
    [{ section: "files" }, "/projects/prj-1/files"],
    [{ section: "explore", tab: "relationships", proposalId: "prp-1" }, "/projects/prj-1/explore/relationships?proposal=prp-1"],
    [{ section: "datasets", datasetId: "ds-1", tab: "versions", reviewId: "rv-1" }, "/projects/prj-1/datasets/ds-1/versions/reviews/rv-1"],
    [{ section: "datasets", datasetId: "ds-1", tab: "versions" }, "/projects/prj-1/datasets/ds-1/versions"],
    [{ section: "datasets", datasetId: "ds-1" }, "/projects/prj-1/datasets/ds-1"],
    [{ section: "studio", taskId: "tsk-1" }, "/projects/prj-1/studio/tsk-1"],
    [{ section: "settings" }, "/projects/prj-1/settings/general"],
    [{ section: "settings", tab: "plugins" }, "/projects/prj-1/settings/plugins"],
  ])("%j → %s", (t, url) => expect(targetUrl(p, t)).toBe(url));
});

describe("Files URLs (todo7 D11)", () => {
  it("names the section files; sources is an alias", () => {
    expect(projectUrl("p", "files")).toBe("/projects/p/files");
    expect(projectUrl("p", "sources")).toBe("/projects/p/files");
    expect(sourcesUrl("p", "seq:a:b")).toBe(filesUrl("p", "seq:a:b"));
    expect(filesUrl("p", "seq:a:b", { q: "x" })).toBe("/projects/p/files/seq%3Aa%3Ab?q=x");
    expect(trashUrl("p")).toBe("/projects/p/files/trash");
  });

  it.each([
    ["/projects/p/sources", "", "/projects/p/files"],
    ["/projects/p/sources/n1", "?import=imp-1", "/projects/p/files/n1?import=imp-1"],
    ["/projects/p/sources/seq%3Aa%3Ab", "?status=held", "/projects/p/files/seq%3Aa%3Ab?status=held"],
  ])("redirects %s%s", (path, search, to) => expect(filesRedirect(path, search)).toBe(to));
});
