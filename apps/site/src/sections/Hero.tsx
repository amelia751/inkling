import { useRef } from "react";
import { ArrowRightIcon } from "@studio/ui/icons";
import { APP_URL, NAME } from "@/content";
import { stagger, useCanvasLoop, useReveal } from "@/lib/motion";
import { Sorter } from "./sorter";

function SortingBand() {
  const ref = useRef<HTMLCanvasElement>(null);
  const sim = useRef<Sorter | null>(null);
  const last = useRef(0);
  useCanvasLoop(ref, (ctx, w, h, t) => {
    if (!sim.current?.fits(w, h)) sim.current = new Sorter(w, h);
    sim.current.step(Math.min(0.05, Math.max(0, t - last.current)));
    last.current = t;
    sim.current.draw(ctx);
  });
  return <canvas ref={ref} aria-label="Raw samples flowing through labelling into five labelled lanes" className="block h-[260px] w-full md:h-[300px]" />;
}

export function Hero() {
  const ref = useReveal<HTMLElement>();
  return (
    <section id="top" ref={ref} className="relative -mt-16 overflow-hidden pt-16">
      <div className="pointer-events-none absolute -top-40 -left-40 size-[520px] rounded-full bg-lilac/70 blur-3xl" />
      <div className="relative shell pt-24 md:pt-32">
        <h1 data-reveal className="max-w-[1100px] text-[56px] leading-[0.9] tracking-[-0.02em] sm:text-[72px] lg:text-hero">
          Raw data in. Datasets out.
        </h1>
        <p data-reveal style={stagger(1)} className="mt-8 max-w-[720px] text-lead font-semibold">
          Drop in scans, signals or video. {NAME} sets up the dataset, the labels and the Studio while you watch.
        </p>
        <div data-reveal style={stagger(2)} className="mt-8 flex flex-wrap gap-2">
          <a href={APP_URL} className="btn-primary">
            Start your first dataset
          </a>
          <a href="#journey" className="btn-secondary">
            See how it works <ArrowRightIcon className="size-4" />
          </a>
        </div>
      </div>
      <div data-reveal style={stagger(3)} className="relative mt-10 pb-6">
        <SortingBand />
      </div>
    </section>
  );
}
