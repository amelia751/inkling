import { describe, expect, it } from "vitest";
import { usePendingAsks } from "./pending-ask";

describe("pending asks (todo15 D4)", () => {
  it("keeps a drop queued with no text, so the drawer still sends it and the reply lands in the drop's conversation", () => {
    const drop = { dropId: "drop-1", messageId: "msg-1" };
    usePendingAsks.getState().queue("p1", "", drop);
    expect(usePendingAsks.getState().take("p1")).toEqual({ text: "", drop });
    expect(usePendingAsks.getState().take("p1")).toBeUndefined();
  });
});
