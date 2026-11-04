import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dropped: Record<string, unknown>[] = [];
vi.mock("./drop-adapter", async (orig) => ({
  ...(await orig<object>()),
  useDropFiles: () => async (req: Record<string, unknown>) => {
    dropped.push(req);
    (req.onUploadKey as ((k: string) => void) | undefined)?.("upload-1");
  },
}));
let chatDrops = true;
vi.mock("@/studio/lib/features", async (orig) => ({ ...(await orig<object>()), feature: (name: string) => (name === "chatDrops" ? chatDrops : false) }));
vi.mock("@/studio/stores/agent", () => ({ useAgent: { getState: () => ({ ensureConversation: async () => ({ id: "conv-1", title: "Chat" }) }) } }));

import { useShell } from "@/studio/stores/shell";
import { useChatDrop, useSendWithAttachments } from "./empty-states";
import { usePendingAsks } from "./pending-ask";
import { useComposerAttachments } from "./composer-attachments";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const picked = { files: [{ file: new File(["x"], "a.png"), relPath: "a.png", size: 1 }], skipped: 0 } as never;

describe("todo29 D1: attaching never sends", () => {
  let root: ReturnType<typeof createRoot>;
  let hooks: { drop: ReturnType<typeof useChatDrop>; send: ReturnType<typeof useSendWithAttachments> };
  const Probe = () => {
    hooks = { drop: useChatDrop("p1"), send: useSendWithAttachments("p1") };
    return null;
  };

  beforeEach(() => {
    sessionStorage.clear();
    dropped.length = 0;
    usePendingAsks.setState({ asks: {} });
    useComposerAttachments.setState({ byProject: {} });
    useShell.setState({ assistantOpen: false });
    root = createRoot(document.createElement("div"));
    act(() => root.render(createElement(Probe)));
  });
  afterEach(() => act(() => root.unmount()));

  it("a drop on the empty Overview uploads in the chat's conversation but queues nothing and keeps the drawer shut", async () => {
    chatDrops = true;
    await act(() => hooks.drop(picked));
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({ origin: "chat", conversationId: "conv-1" });
    expect(usePendingAsks.getState().asks).toEqual({});
    expect(useShell.getState().assistantOpen).toBe(false);
    const a = useComposerAttachments.getState().byProject.p1;
    expect(a?.drop?.dropId).toBe(dropped[0].dropId);
    // A second drop before Send joins the same drop.
    await act(() => hooks.drop(picked));
    expect(dropped[1].dropId).toBe(a?.drop?.dropId);
  });

  it("Send queues the text with the drop and opens the drawer then", async () => {
    chatDrops = true;
    await act(() => hooks.drop(picked));
    const drop = useComposerAttachments.getState().byProject.p1?.drop;
    act(() => hooks.send("Make me a Studio"));
    expect(usePendingAsks.getState().asks.p1).toEqual({ text: "Make me a Studio", drop });
    expect(useShell.getState().assistantOpen).toBe(true);
    expect(useComposerAttachments.getState().byProject.p1).toBeUndefined();
  });

  it("Send with no text still sends the attached files", async () => {
    chatDrops = true;
    await act(() => hooks.drop(picked));
    act(() => hooks.send(""));
    expect(usePendingAsks.getState().asks.p1?.drop).toBeTruthy();
  });

  it("chat drops off: the tray upload waits for Send too", async () => {
    chatDrops = false;
    await act(() => hooks.drop(picked));
    expect(usePendingAsks.getState().asks).toEqual({});
    act(() => hooks.send("Label these"));
    expect(usePendingAsks.getState().asks.p1).toEqual({ text: "Label these", upload: { key: "upload-1" } });
  });

  it("Send with nothing attached and no text does nothing", () => {
    act(() => hooks.send("  "));
    expect(usePendingAsks.getState().asks).toEqual({});
    expect(useShell.getState().assistantOpen).toBe(false);
  });
});
