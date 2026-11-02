import { useRef } from "react";
import { ArrowRightIcon, CheckIcon } from "@studio/ui/icons";
import { APP_URL, NAME } from "@/content";
import { stagger, useCountUp, useCycle, useInView, useReducedMotion, useReveal } from "@/lib/motion";

/** One real local run (todo15 §6, run 3, J2 text): the numbers the card counts up to. */
const RUN = [
  { at: 0.1, text: "Studio booted from preset" },
  { at: 4.6, text: "Read 20 file facts" },
  { at: 9.8, text: "Planned 5 labels" },
  { at: 13.2, text: "Labels added to the Studio" },
];

function Seconds({ start }: { start: boolean }) {
  const seconds = useCountUp(13.2, start, 5200);
  return <>{seconds.toFixed(1)} s</>;
}

function RunCard() {
  const ref = useRef<HTMLDivElement>(null);
  const visible = useInView(ref);
  const reduced = useReducedMotion();
  const [loop] = useCycle(1000, 9000, visible && !reduced);
  return (
    <div ref={ref} className="w-full max-w-[380px] rounded-card border border-line bg-white p-8">
      <div className="flex items-center justify-between">
        <span className="text-[24px] leading-7 font-semibold">Chest X-ray</span>
        <span className="flex items-center gap-2 text-caption text-ink/60">
          <span className="animate-pulse-dot size-2 rounded-full bg-violet" /> Live run
        </span>
      </div>
      <div className="mt-6 display text-[44px] leading-[48px] tabular-nums">
        <Seconds key={loop} start={visible} />
      </div>
      <div className="text-caption text-ink/60">from one sentence to a labelled Studio</div>
      <ul key={loop} className="mt-6 space-y-2">
        {RUN.map((r, i) => (
          <li key={r.text} className="animate-fade-up flex items-center gap-3 text-caption" style={{ animationDelay: `${0.3 + i * 1.2}s` }}>
            <span className="flex size-5 items-center justify-center rounded-full bg-lime">
              <CheckIcon className="size-3" />
            </span>
            <span className="flex-1">{r.text}</span>
            <span className="text-ink/40 tabular-nums">{r.at.toFixed(1)} s</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AssistantBanner() {
  const ref = useReveal<HTMLElement>();
  return (
    <section ref={ref} className="shell py-6">
      <div className="relative grid items-center gap-10 overflow-hidden rounded-panel bg-lilac p-8 md:p-14 lg:grid-cols-[1fr_auto]">
        <svg aria-hidden className="pointer-events-none absolute -right-10 -bottom-24 h-[420px] opacity-60" viewBox="0 0 400 400" fill="none">
          {Array.from({ length: 14 }, (_, i) => (
            <circle key={i} cx="200" cy="200" r={30 + i * 13} stroke="var(--color-lilac-strong)" strokeWidth="1.5" />
          ))}
        </svg>
        <div className="relative">
          <span data-reveal className="chip bg-white font-medium text-violet">New</span>
          <h3 data-reveal style={stagger(1)} className="mt-4 max-w-[520px] text-[28px] leading-9 font-semibold md:text-h3">
            Meet the assistant that sets up your Studio
          </h3>
          <p data-reveal style={stagger(2)} className="mt-4 max-w-[520px]">
            Describe the task in a sentence or just drop files. {NAME} plans the dataset, picks the viewer and adds your labels, and
            you can undo any of it.
          </p>
          <div data-reveal style={stagger(3)} className="mt-8 flex flex-wrap gap-2">
            <a href={APP_URL} className="btn-primary">
              Try the assistant
            </a>
            <a href="#journey" className="btn text-ink hover:bg-white/60">
              How it works <ArrowRightIcon className="size-4" />
            </a>
          </div>
        </div>
        <div data-reveal style={stagger(2)} className="relative justify-self-center lg:justify-self-end">
          <RunCard />
        </div>
      </div>
    </section>
  );
}
