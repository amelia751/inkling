import { ArrowRightIcon } from "@studio/ui/icons";
import { APP_URL, NAME } from "@/content";
import { stagger, useReveal } from "@/lib/motion";
import { StudioDemo } from "./StudioDemo";

export function Hero() {
  const ref = useReveal<HTMLElement>();
  return (
    <section id="top" ref={ref} className="relative -mt-16 overflow-hidden pt-16">
      <div className="pointer-events-none absolute -top-40 -left-40 size-[520px] rounded-full bg-lilac/70 blur-3xl" />
      <div className="pointer-events-none absolute top-24 -right-32 size-[560px] rounded-full bg-lime/40 blur-3xl" />
      <div className="relative shell grid items-center gap-12 pt-20 pb-24 md:pt-28 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] lg:gap-14">
        <div>
          <h1 data-reveal className="text-[52px] leading-[0.95] tracking-[-0.02em] sm:text-[60px] xl:text-[64px]">
            Raw data in.
            <br />
            Datasets out.
          </h1>
          <p data-reveal style={stagger(1)} className="mt-7 max-w-[520px] text-[20px] leading-7 font-semibold">
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
        <div data-reveal style={stagger(2)}>
          <StudioDemo />
        </div>
      </div>
    </section>
  );
}
