import { useRef } from "react";
import { ArrowLeftIcon, ArrowRightIcon } from "@studio/ui/icons";
import { ILLUSTRATIONS } from "@studio/ui/illustrations";
import { NAME, NEWS } from "@/content";
import { stagger, useReveal } from "@/lib/motion";

const TINTS = ["bg-lime", "bg-white", "bg-lilac-strong", "bg-mist", "bg-lime-soft"];

export function News() {
  const ref = useReveal<HTMLElement>();
  const track = useRef<HTMLUListElement>(null);
  const scroll = (dir: number) => track.current?.scrollBy({ left: dir * 312, behavior: "smooth" });
  return (
    <section id="news" ref={ref} className="scroll-mt-20 bg-lilac py-24">
      <div className="shell grid gap-10 lg:grid-cols-[400px_1fr]">
        <div className="flex flex-col">
          <h2 data-reveal className="text-[36px] leading-[1.1] md:text-h2">
            What’s new in {NAME}
          </h2>
          <p data-reveal style={stagger(1)} className="mt-4 text-ink/70">
            We ship every week. Here is what changed lately.
          </p>
          <div data-reveal style={stagger(2)} className="mt-8 flex gap-2 lg:mt-auto">
            <button onClick={() => scroll(-1)} aria-label="Previous" className="flex size-11 items-center justify-center rounded-control bg-white hover:bg-white/70">
              <ArrowLeftIcon className="size-4" />
            </button>
            <button onClick={() => scroll(1)} aria-label="Next" className="flex size-11 items-center justify-center rounded-control bg-white hover:bg-white/70">
              <ArrowRightIcon className="size-4" />
            </button>
          </div>
        </div>
        <ul ref={track} className="-mr-6 flex snap-x snap-mandatory gap-4 overflow-x-auto pr-6 pb-2 [mask-image:linear-gradient(90deg,black_85%,transparent)] [scrollbar-width:none] md:-mr-12 md:pr-12">
          {NEWS.map((n, i) => {
            const Art = ILLUSTRATIONS[n.art];
            return (
              <li key={n.title} data-reveal style={stagger(i + 1)} className="w-[296px] shrink-0 snap-start">
                <a href="#news" className="group flex h-full flex-col overflow-hidden rounded-card bg-white">
                  <div className={`flex aspect-square items-center justify-center ${TINTS[i % TINTS.length]}`}>
                    <Art className="size-40 transition-transform duration-500 ease-(--ease-out-soft) group-hover:scale-110 group-hover:-rotate-3" />
                  </div>
                  <div className="flex flex-1 flex-col gap-3 p-6">
                    <span className="text-caption text-ink/50">{n.date}</span>
                    <span className="text-ui text-black/85">{n.title}</span>
                    <span className="mt-auto flex items-center gap-1 text-caption text-link">
                      Read more <ArrowRightIcon className="size-3 transition-transform group-hover:translate-x-1" />
                    </span>
                  </div>
                </a>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
