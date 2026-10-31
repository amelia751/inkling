/**
 * Drag helpers shared by the file tree and the app's drag controller (todo7 §2 Drag and drop).
 */

/** The drop-target look: `--g-selection-hover` fill and a 1px `--g-line-focus` ring (one visual for "this goes here"). */
export const DROP_TARGET_CLASS = "bg-selection-hover ring-1 ring-ring ring-inset"

/** Hovering a closed folder this long during a drag opens it (spring-loaded folders). */
export const SPRING_LOAD_MS = 700

/**
 * Scroll `el` when the pointer is within `edge` px of its top or bottom (or left/right, with `horizontal`) edge
 * during a drag; faster the closer it gets. Call it from `dragover`. Returns whether it scrolled.
 */
export function edgeAutoScroll(el: HTMLElement | null | undefined, clientX: number, clientY: number, { edge = 32, maxStep = 18, horizontal = false }: { edge?: number; maxStep?: number; horizontal?: boolean } = {}): boolean {
  if (!el) return false
  const r = el.getBoundingClientRect()
  if (clientX < r.left || clientX > r.right || clientY < r.top - edge || clientY > r.bottom + edge) return false
  const step = (d: number) => Math.ceil(maxStep * (1 - Math.max(0, d) / edge))
  let dy = 0
  let dx = 0
  if (clientY - r.top < edge) dy = -step(clientY - r.top)
  else if (r.bottom - clientY < edge) dy = step(r.bottom - clientY)
  if (!horizontal) dx = 0
  else if (clientX - r.left < edge) dx = -step(clientX - r.left)
  else if (r.right - clientX < edge) dx = step(r.right - clientX)
  if (!dx && !dy) return false
  const before = [el.scrollLeft, el.scrollTop]
  el.scrollBy(dx, dy)
  return el.scrollLeft !== before[0] || el.scrollTop !== before[1]
}
