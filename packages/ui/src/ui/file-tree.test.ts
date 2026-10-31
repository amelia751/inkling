import * as React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { FileTree, type FileTreeHandle, type FileTreeNode, type FileTreeProps } from "./file-tree"

// jsdom has no layout: give the tree a size so arborist renders its rows.
class FakeResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe() {
    this.cb([{ contentRect: { width: 300, height: 600 } } as ResizeObserverEntry], this as unknown as ResizeObserver)
  }
  unobserve() {}
  disconnect() {}
}

const Icon = () => null
const file = (id: string, name: string): FileTreeNode => ({ id, name, icon: Icon })
const folder = (id: string, name: string, children: FileTreeNode[] = []): FileTreeNode => ({ id, name, icon: Icon, children })

const DATA: FileTreeNode[] = [
  folder("mri", "MRI", [folder("p1", "patient_001", [file("s1", "scan001.dcm")]), folder("p2", "patient_002", [file("s2", "t1.nii.gz")])]),
  file("notes", "notes.txt"),
  folder("ct", "CT / series_1", []),
]

let root: Root
let host: HTMLDivElement
const ref = React.createRef<FileTreeHandle>()

async function render(props: Partial<FileTreeProps> = {}) {
  await act(async () => {
    root.render(React.createElement(FileTree, { ref, data: DATA, "aria-label": "Files", ...props }))
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

const rowNames = () => [...host.querySelectorAll<HTMLElement>("[data-node-id]")].map((r) => r.dataset.nodeId)
const input = () => host.querySelector<HTMLInputElement>("[data-testid=tree-rename-input]")

function type(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event("input", { bubbles: true }))
}
const key = (el: Element, k: string) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }))

describe("FileTree (todo7)", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver)
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    host = document.createElement("div")
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  })

  it("renders read-only as before: no rename, no drag", async () => {
    await render()
    expect(rowNames()).toEqual(["mri", "notes", "ct"])
    await act(async () => ref.current!.edit("notes"))
    expect(input()).toBeNull()
    expect(host.querySelector("[data-node-id=notes]")!.getAttribute("draggable")).toBeNull()
  })

  it("renames inline: stem selected, live validation, Enter saves", async () => {
    const onRename = vi.fn()
    const validate = (name: string) => (name.toLowerCase() === "mri" ? "A folder named “MRI” is already here" : null)
    await render({ editable: true, onRename, validate })
    await act(async () => ref.current!.edit("notes"))
    const el = input()!
    expect(el.value).toBe("notes.txt")
    expect(el.getAttribute("aria-label")).toBe("Rename notes.txt")
    expect([el.selectionStart, el.selectionEnd]).toEqual([0, 5])
    await act(async () => type(el, "MRI"))
    expect(host.querySelector("[data-testid=tree-rename-error]")?.textContent).toMatch(/already here/)
    expect(el.getAttribute("aria-invalid")).toBe("true")
    await act(async () => key(el, "Enter"))
    expect(onRename).not.toHaveBeenCalled()
    await act(async () => type(el, "case.txt"))
    await act(async () => key(el, "Enter"))
    expect(onRename).toHaveBeenCalledWith("notes", "case.txt")
  })

  it("selects the stem of a two-part extension; Esc cancels and reports it", async () => {
    const onRenameCancel = vi.fn()
    await render({ editable: true, onRename: vi.fn(), onRenameCancel, initialOpen: ["mri", "p2"] })
    await act(async () => ref.current!.edit("s2"))
    const el = input()!
    expect([el.selectionStart, el.selectionEnd]).toEqual([0, 2])
    await act(async () => key(el, "Escape"))
    expect(input()).toBeNull()
    expect(onRenameCancel).toHaveBeenCalledWith("s2")
  })

  it("filters the loaded tree on any segment of a compact chain", async () => {
    await render({ searchTerm: "series" })
    expect(rowNames()).toEqual(["ct"])
    await render({ searchTerm: "scan001" })
    expect(rowNames()).toEqual(["mri", "p1", "s1"])
  })

  it("draws cut rows at half opacity and shows row actions", async () => {
    await render({ cutIds: ["notes"], rowActions: (n) => (n.children ? React.createElement("button", { type: "button" }, "+") : null) })
    expect(host.querySelector("[data-node-id=notes]")!.getAttribute("data-cut")).toBe("true")
    expect(host.querySelector("[data-node-id=notes]")!.className).toMatch(/opacity-50/)
    expect(host.querySelectorAll("[data-testid=tree-row-actions]").length).toBe(2)
  })

  it("collapses all and expands recursively up to a cap", async () => {
    const onToggle = vi.fn()
    await render({ onToggle })
    let hit = false
    await act(async () => {
      hit = ref.current!.openRecursive("mri", 2000)
    })
    expect(hit).toBe(false)
    expect(rowNames()).toEqual(["mri", "p1", "s1", "p2", "s2", "notes", "ct"])
    await act(async () => ref.current!.closeAll())
    expect(rowNames()).toEqual(["mri", "notes", "ct"])
    await act(async () => {
      hit = ref.current!.openRecursive("mri", 1)
    })
    expect(hit).toBe(true)
    expect(onToggle).toHaveBeenCalledWith("mri", true)
  })

  it("keeps Enter as open when rename is on", async () => {
    const onActivate = vi.fn()
    await render({ editable: true, onRename: vi.fn(), onActivate })
    const treeEl = host.querySelector<HTMLElement>("[role=tree]")!
    await act(async () => {
      ref.current!.api()!.focus("notes")
    })
    await act(async () => key(host.querySelector("[data-node-id=notes]")!, "Enter"))
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    expect(onActivate).toHaveBeenCalledWith("notes")
    expect(input()).toBeNull()
    void treeEl
  })

  it("follows a controlled multi-selection", async () => {
    await render({ selectedIds: ["notes", "ct"] })
    const selected = [...host.querySelectorAll("[role=treeitem][aria-selected=true]")].map((r) => r.querySelector<HTMLElement>("[data-node-id]")?.dataset.nodeId)
    expect(selected).toEqual(["notes", "ct"])
  })
})
