import { useRef } from "react";
import { ArrowRightIcon } from "@studio/ui/icons";
import { APP_URL, NAME } from "@/content";
import { stagger, useCanvasLoop, useReveal } from "@/lib/motion";

const SHADE = [196, 236, 24];
const LIME = [224, 255, 79];
const GLINT = [246, 255, 200];
const STRANDS = 64;
const SEGMENTS = 44;

/** A ribbon of lime strands that twists along the page and slowly flows; a label box rides one knot. */
function drawRibbon(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, pointer: number) {
  ctx.clearRect(0, 0, w, h);
  const size = Math.min(h, w * 0.55);
  const at = (u: number) => {
    const center = h * 0.64 + size * 0.1 * Math.sin(u * Math.PI * 1.4 + t * 0.3);
    const theta = u * Math.PI * 2.3 - 0.6 + t * 0.38 + pointer * 0.5;
    const width = size * (0.24 + 0.05 * Math.sin(u * 4 + t * 0.25));
    return { center, theta, width };
  };
  ctx.lineCap = "round";
  for (let k = 0; k < STRANDS; k++) {
    const v = (k / (STRANDS - 1)) * 2 - 1;
    let prev: [number, number] | null = null;
    for (let s = 0; s <= SEGMENTS; s++) {
      const u = s / SEGMENTS;
      const x = -40 + u * (w + 80);
      const { center, theta, width } = at(u);
      const y = center + v * width * Math.cos(theta);
      if (prev) {
        // Strands facing the light go pale; the far side deepens past lime.
        const light = 0.5 + 0.5 * Math.sin(theta) * v;
        const [from, to, f] = light < 0.5 ? [SHADE, LIME, light * 2] : [LIME, GLINT, (light - 0.5) * 2];
        const [r, g, b] = from.map((c, i) => Math.round(c + (to[i] - c) * f));
        const edge = 1 - Math.abs(v) * 0.55;
        ctx.strokeStyle = `rgba(${r},${g},${b},${0.7 + 0.3 * edge})`;
        ctx.lineWidth = 1.1 + edge;
        ctx.beginPath();
        ctx.moveTo(prev[0], prev[1]);
        ctx.lineTo(x, y);
        ctx.stroke();
      }
      prev = [x, y];
    }
  }

  if (w < 640) return;
  // The label box: tracks the ribbon at 74% of the width, sized to its current thickness.
  const u = 0.74;
  const { center, theta, width } = at(u);
  const half = Math.max(26, Math.abs(Math.cos(theta)) * width);
  const x = u * w - 40 + u * 80;
  const bw = 120;
  const top = center - half - 10;
  const bh = half * 2 + 20;
  ctx.strokeStyle = "rgb(5,43,66)";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 5]);
  ctx.lineDashOffset = -t * 18;
  ctx.strokeRect(x - bw / 2, top, bw, bh);
  ctx.setLineDash([]);
  ctx.fillStyle = "rgb(5,43,66)";
  for (const [cx, cy] of [[x - bw / 2, top], [x + bw / 2, top], [x - bw / 2, top + bh], [x + bw / 2, top + bh]]) ctx.fillRect(cx - 3.5, cy - 3.5, 7, 7);
  const label = `strand · ${(0.86 + 0.1 * Math.sin(t * 0.7)).toFixed(2)}`;
  ctx.font = "500 12px 'Inter Variable', sans-serif";
  const tw = ctx.measureText(label).width + 16;
  ctx.beginPath();
  ctx.roundRect(x - bw / 2, top - 26, tw, 20, 6);
  ctx.fill();
  ctx.fillStyle = "white";
  ctx.fillText(label, x - bw / 2 + 8, top - 12);
}

function Ribbon() {
  const ref = useRef<HTMLCanvasElement>(null);
  const pointer = useRef(0);
  const eased = useRef(0);
  useCanvasLoop(ref, (ctx, w, h, t) => {
    eased.current += (pointer.current - eased.current) * 0.04;
    drawRibbon(ctx, w, h, t, eased.current);
  });
  return (
    <canvas
      ref={ref}
      aria-hidden
      className="absolute inset-0 size-full"
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        pointer.current = (e.clientX - r.left) / r.width - 0.5;
      }}
    />
  );
}

export function Hero() {
  const ref = useReveal<HTMLElement>();
  return (
    <section id="top" ref={ref} className="relative -mt-16 overflow-hidden pt-16">
      <div className="absolute inset-x-0 top-0 h-[760px]">
        <Ribbon />
      </div>
      <div className="pointer-events-none relative shell flex min-h-[700px] flex-col pt-28 pb-24 md:pt-36">
        <h1 data-reveal className="max-w-[1100px] text-[56px] leading-[0.9] tracking-[-0.02em] sm:text-[72px] lg:text-hero">
          Raw data in. Datasets out.
        </h1>
        <p data-reveal style={stagger(1)} className="mt-8 max-w-[720px] text-lead font-semibold">
          Drop in scans, signals or video. {NAME} sets up the dataset, the labels and the Studio while you watch.
        </p>
        <div data-reveal style={stagger(2)} className="pointer-events-auto mt-8 flex flex-wrap gap-2">
          <a href={APP_URL} className="btn-primary">
            Start your first dataset
          </a>
          <a href="#journey" className="btn-secondary">
            See how it works <ArrowRightIcon className="size-4" />
          </a>
        </div>
      </div>
    </section>
  );
}
