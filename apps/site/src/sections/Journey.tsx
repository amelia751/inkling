import { useRef } from "react";
import { JOURNEY } from "@/content";
import { stagger, useCycle, useInView, useReducedMotion, useReveal } from "@/lib/motion";
import { SCENES } from "./scenes";

const STEP_MS = 7000;

export function Journey() {
  const ref = useReveal<HTMLElement>();
  const panel = useRef<HTMLDivElement>(null);
  const visible = useInView(panel);
  const reduced = useReducedMotion();
  const [active, go] = useCycle(JOURNEY.length, STEP_MS, visible && !reduced);
  const Scene = SCENES[active];

  return (
    <section id="journey" ref={ref} className="shell scroll-mt-20 py-24">
      <h2 data-reveal className="max-w-[760px] text-[36px] leading-[1.1] md:text-h2">
        From upload to dataset. In one conversation.
      </h2>
      <div className="mt-14 grid gap-10 lg:grid-cols-[5fr_7fr] lg:gap-16">
        <ol className="flex flex-col" role="tablist" aria-label="How it works">
          {JOURNEY.map((s, i) => {
            const on = i === active;
            return (
              <li key={s.title} data-reveal style={stagger(i + 1)} className="border-t border-line first:border-t-0">
                <button role="tab" aria-selected={on} onClick={() => go(i)} className="group w-full py-6 text-left">
                  <span className="flex items-baseline gap-4">
                    <span className={`text-caption font-semibold tabular-nums transition-colors ${on ? "text-violet" : "text-ink/30"}`}>0{i + 1}</span>
                    <span className={`text-[26px] leading-8 font-bold transition-colors duration-300 md:text-h3 ${on ? "text-ink" : "text-ink/30 group-hover:text-ink/60"}`}>{s.title}</span>
                  </span>
                  <span className={`grid transition-[grid-template-rows,opacity] duration-500 ease-(--ease-out-soft) ${on ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}>
                    <span className="overflow-hidden">
                      <span className="block max-w-[440px] pt-3 pl-9 text-ui text-ink/70">{s.text}</span>
                    </span>
                  </span>
                  <span className="mt-5 ml-9 block h-0.5 overflow-hidden rounded-full bg-line">
                    {on && (
                      <span
                        key={`${active}-${visible}`}
                        className="block h-full origin-left bg-ink"
                        style={{ animation: visible && !reduced ? `progress ${STEP_MS}ms linear both` : "none", transform: visible && !reduced ? undefined : "scaleX(1)" }}
                      />
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
        <div
          ref={panel}
          data-reveal
          style={stagger(2)}
          className="relative flex min-h-[460px] items-center justify-center overflow-hidden rounded-panel bg-mist p-6 md:p-12"
          role="tabpanel"
        >
          <div className="pointer-events-none absolute -top-24 -right-24 size-72 rounded-full bg-lime/50 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-28 -left-20 size-72 rounded-full bg-lilac blur-3xl" />
          <div key={active} className="animate-fade-up relative w-full max-w-[520px]">
            <Scene />
          </div>
        </div>
      </div>
    </section>
  );
}
