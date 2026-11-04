// Canary (todo23 W9): a GPL charting library renamed through an npm alias and vendored. Known bad.
import { draw } from "fast-chart";
export const render = (el: HTMLElement, values: number[]) => draw(el, values);
