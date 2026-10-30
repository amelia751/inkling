import { useEffect } from "react";

/**
 * Stop the trackpad "swipe back" gesture on every page, so a horizontal swipe pans the
 * image or scrolls a strip instead of leaving the page. CSS `overscroll-behavior-x: none` covers
 * Chromium and Firefox; Safari ignores it, so horizontal wheel events that nothing on the
 * page can scroll are cancelled here. Back stays available through the browser button,
 * ⌘[ and the in-app navigation.
 */
export function useNoSwipeBack() {
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      // Let horizontally scrollable areas (toolbars, timelines) scroll themselves.
      for (let el = e.target as HTMLElement | null; el && el !== document.body; el = el.parentElement) {
        if (el.scrollWidth > el.clientWidth && /(auto|scroll)/.test(getComputedStyle(el).overflowX)) {
          const atStart = el.scrollLeft <= 0, atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
          if ((e.deltaX < 0 && !atStart) || (e.deltaX > 0 && !atEnd)) return;
        }
      }
      e.preventDefault();
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, []);
}
