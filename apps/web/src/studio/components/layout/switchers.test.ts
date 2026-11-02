import { describe, expect, it } from "vitest";
import { workspaceName } from "./switchers";

describe("workspaceName (todo14 D1)", () => {
  const personal = { id: "o1", workosOrgId: null, name: "Personal" };
  it("names a personal org after the person's first name", () => {
    expect(workspaceName(personal, "Dana")).toBe("Dana's workspace");
  });
  it("keeps Personal without a first name or a session", () => {
    expect(workspaceName(personal, null)).toBe("Personal");
    expect(workspaceName(undefined, "Dana")).toBe("Personal");
  });
  it("shows a team org's own name", () => {
    expect(workspaceName({ ...personal, name: "Radiology Lab" }, "Dana")).toBe("Radiology Lab");
  });
});
