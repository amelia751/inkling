import { useRef } from "react";
import { BUILDERS } from "@/content";
import { stagger, useCanvasLoop, useCycle, useInView, useReducedMotion, useReveal } from "@/lib/motion";

const SWEEP = 4.5;
const CYCLE = 7;

let noise: HTMLCanvasElement | null = null;
function grain() {
  if (noise) return noise;
  noise = document.createElement("canvas");
  noise.width = noise.height = 256;
  const ctx = noise.getContext("2d")!;
  const img = ctx.createImageData(256, 256);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() * 255;
    img.data.set([v, v, v, 22], i);
  }
  ctx.putImageData(img, 0, 0);
  return noise;
}

/** An organ outline: a wobbly closed curve around (cx, cy) that changes slowly from slice to slice. */
function blob(ctx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number, slice: number, seed: number) {
  ctx.beginPath();
  for (let a = 0; a <= Math.PI * 2 + 0.01; a += Math.PI / 40) {
    const wob = 1 + 0.08 * Math.sin(a * 3 + seed + slice * 0.9) + 0.05 * Math.sin(a * 5 - seed * 2 + slice * 0.6);
    const x = cx + Math.cos(a) * rx * wob;
    const y = cy + Math.sin(a) * ry * wob;
    a === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/** A drawn axial CT slice: a lime scan line sweeps down and traces the liver, then the label is accepted. */
function drawSlice(ctx: CanvasRenderingContext2D, w: number, h: number, t: number) {
  const phase = t % CYCLE;
  const slice = Math.floor(t / CYCLE) * 3 + 84;
  const cx = w / 2;
  const cy = h / 2 + 6;
  const s = Math.min(w / 640, h / 420);

  ctx.fillStyle = "#05121b";
  ctx.fillRect(0, 0, w, h);

  const body = ctx.createRadialGradient(cx, cy, 20 * s, cx, cy, 260 * s);
  body.addColorStop(0, "#5b6670");
  body.addColorStop(1, "#2e3740");
  blob(ctx, cx, cy, 250 * s, 160 * s, slice * 0.2, 0.3);
  ctx.fillStyle = body;
  ctx.fill();
  blob(ctx, cx, cy, 236 * s, 146 * s, slice * 0.2, 0.3);
  ctx.fillStyle = "#3d4750";
  ctx.fill();

  const organs: [number, number, number, number, number, string][] = [
    [cx - 70 * s, cy - 20 * s, 105 * s, 78 * s, 1.2, "#7b858e"], // liver
    [cx + 95 * s, cy - 40 * s, 52 * s, 40 * s, 2.4, "#6c757d"], // stomach
    [cx - 115 * s, cy + 70 * s, 30 * s, 24 * s, 3.1, "#8a939b"], // kidney
    [cx + 120 * s, cy + 70 * s, 30 * s, 24 * s, 4.2, "#8a939b"],
    [cx + 12 * s, cy + 52 * s, 16 * s, 16 * s, 5.0, "#a7afb6"], // aorta
  ];
  for (const [x, y, rx, ry, seed, fill] of organs) {
    blob(ctx, x, y, rx, ry, slice * 0.3, seed);
    ctx.fillStyle = fill;
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(cx, cy + 105 * s, 28 * s, 0, Math.PI * 2);
  ctx.fillStyle = "#d9dee2";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy + 105 * s, 14 * s, 0, Math.PI * 2);
  ctx.fillStyle = "#4a535b";
  ctx.fill();

  ctx.fillStyle = ctx.createPattern(grain(), "repeat")!;
  ctx.fillRect(0, 0, w, h);

  // Sweep, contour, then label.
  const [lx, ly, lrx, lry, lseed] = organs[0];
  const sweep = Math.min(1, phase / SWEEP);
  const scanY = cy - 170 * s + sweep * 340 * s;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, scanY);
  ctx.clip();
  blob(ctx, lx, ly, lrx, lry, slice * 0.3, lseed);
  ctx.fillStyle = "rgba(224,255,79,0.16)";
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgb(224,255,79)";
  ctx.stroke();
  ctx.restore();

  if (sweep < 1) {
    const g = ctx.createLinearGradient(0, scanY - 40, 0, scanY);
    g.addColorStop(0, "rgba(224,255,79,0)");
    g.addColorStop(1, "rgba(224,255,79,0.22)");
    ctx.fillStyle = g;
    ctx.fillRect(0, scanY - 40, w, 40);
    ctx.fillStyle = "rgb(224,255,79)";
    ctx.fillRect(0, scanY - 1, w, 2);
  } else {
    const accepted = phase > SWEEP + 1.2;
    const label = accepted ? "Liver · accepted" : "Liver · suggested";
    ctx.font = "600 13px 'Inter Variable', sans-serif";
    const tw = ctx.measureText(label).width + 20;
    const bx = lx - lrx;
    const by = ly - lry - 34;
    ctx.globalAlpha = Math.min(1, (phase - SWEEP) * 3);
    ctx.fillStyle = accepted ? "rgb(224,255,79)" : "rgba(255,255,255,0.92)";
    ctx.beginPath();
    ctx.roundRect(bx, by, tw, 24, 7);
    ctx.fill();
    ctx.fillStyle = "rgb(5,43,66)";
    ctx.fillText(label, bx + 10, by + 16.5);
    ctx.globalAlpha = 1;
  }

  ctx.font = "12px ui-monospace, Menlo, monospace";
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.fillText("AXIAL", 20, 30);
  ctx.fillText(`Slice ${slice} / 212`, 20, 48);
  ctx.textAlign = "right";
  ctx.fillText("W 400  L 40", w - 20, 30);
  ctx.fillText("Synthetic phantom", w - 20, h - 20);
  ctx.textAlign = "left";
}

function SliceViewer() {
  const ref = useRef<HTMLCanvasElement>(null);
  useCanvasLoop(ref, drawSlice);
  return <canvas ref={ref} aria-label="A CT slice being outlined" className="aspect-[16/9] w-full rounded-card" />;
}

export function Builders() {
  const ref = useReveal<HTMLElement>();
  const list = useRef<HTMLUListElement>(null);
  const visible = useInView(list);
  const reduced = useReducedMotion();
  const [active] = useCycle(BUILDERS.length, 2600, visible && !reduced);
  return (
    <section id="why" ref={ref} className="scroll-mt-20 bg-ink-deep py-24 text-white">
      <div className="shell">
        <h2 data-reveal className="text-[36px] leading-[1.1] md:text-h2">
          Built for the people who know the data
        </h2>
        <p data-reveal style={stagger(1)} className="mt-6 max-w-[760px] text-lead text-white/80">
          Radiologists, cardiologists, pathologists and the teams around them. No setup scripts, no format wrangling.
        </p>
        <div className="mt-12 grid gap-4 lg:grid-cols-[1fr_296px]">
          <div data-reveal style={stagger(2)}>
            <SliceViewer />
          </div>
          <ul ref={list} className="grid gap-1 sm:grid-cols-2 lg:grid-cols-1">
            {BUILDERS.map((b, i) => (
              <li
                key={b.text}
                data-reveal
                style={stagger(i + 2)}
                className={`flex flex-col justify-center gap-3 rounded-card py-6 pr-8 pl-6 transition-colors duration-500 ${
                  i === active ? "bg-ink-raised shadow-[inset_0_0_0_1px_rgb(224_255_79/35%)]" : "bg-ink-raised/60"
                }`}
              >
                <b.icon className={`size-5 transition-colors duration-500 ${i === active ? "text-lime" : "text-white/50"}`} />
                <span className="text-[20px] leading-6">{b.text}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
