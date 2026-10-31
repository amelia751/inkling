import { DragChip, dragLabel } from "@studio/ui/ui/drag-chip";
import { useFsDrag } from "./dnd";

/**
 * The ghost of a Files drag (todo7 §2): "3 items" with the first item's icon, `+` while ⌥
 * copies, and why the folder under the pointer refuses it. Mount once on the Files page; it
 * draws nothing while the pointer is over the tree (the tree draws its own).
 */
export function FsDragGhost() {
  const drag = useFsDrag((s) => s.drag);
  const pointer = useFsDrag((s) => s.pointer);
  const copy = useFsDrag((s) => s.copy);
  const refusal = useFsDrag((s) => s.refusal);
  if (!drag || !pointer) return null;
  const first = drag.items[0];
  return (
    <div style={{ position: "fixed", left: 0, top: 0, zIndex: 100, pointerEvents: "none", transform: `translate(${pointer.x + 12}px, ${pointer.y + 8}px)` }} aria-hidden>
      <DragChip icon={first?.icon} label={dragLabel(drag.items.length, first?.name)} copy={copy} reason={refusal} />
    </div>
  );
}
