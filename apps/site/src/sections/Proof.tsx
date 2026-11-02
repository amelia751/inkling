import { useRef } from "react";
import { LockIcon } from "@studio/ui/icons";
import { DATA_TYPES, NAME, STATS } from "@/content";
import { stagger, useCountUp, useInView, useReveal } from "@/lib/motion";

function Row({ reverse = false }: { reverse?: boolean }) {
  const items = reverse ? [...DATA_TYPES].reverse() : DATA_TYPES;
  return (
    <div className="flex overflow-hidden [mask-image:linear-gradient(90deg,transparent,black_8%,black_92%,transparent)]">
      <ul className="animate-marquee flex shrink-0 gap-3 pr-3 hover:[animation-play-state:paused]" style={reverse ? { animationDirection: "reverse" } : undefined}>
        {[...items, ...items].map((d, i) => (
          <li key={i} aria-hidden={i >= items.length} className="flex h-14 shrink-0 items-center gap-3 rounded-2xl border border-line px-5 text-ui font-semibold text-ink/70 transition-colors hover:bg-lilac hover:text-ink">
            <d.icon className="size-5 text-violet" />
            {d.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function DataTypes() {
  const ref = useReveal<HTMLElement>();
  return (
    <section id="data" ref={ref} className="scroll-mt-20 py-24">
      <div className="shell">
        <h2 data-reveal className="text-[36px] leading-[1.1] md:text-h2">
          One studio for every kind of data
        </h2>
        <p data-reveal style={stagger(1)} className="mt-4 max-w-[640px] text-ink/70">
          Medical imaging first, but the same Studio boots for photos, sensor data and video. Each type brings its own viewer, tools and exports.
        </p>
      </div>
      <div data-reveal style={stagger(2)} className="mt-12 space-y-3">
        <Row />
        <Row reverse />
      </div>
    </section>
  );
}

const CASE_STATS = [
  { value: "13 s", text: "from one sentence to a Studio with five labels" },
  { value: "$0.04", text: "of model cost for the whole set-up" },
  { value: "0 bytes", text: "of image data sent to the model" },
];

export function Example() {
  const ref = useReveal<HTMLElement>();
  return (
    <section ref={ref} className="shell py-12">
      <div className="grid gap-10 rounded-panel bg-mist p-8 md:p-[52px] lg:grid-cols-[1fr_436px]">
        <div className="flex flex-col">
          <div data-reveal className="flex flex-wrap gap-2">
            {["Classification", "Chest X-ray", "Assistant"].map((c, i) => (
              <span key={c} className={`chip bg-white ${i === 2 ? "text-sky" : "text-violet"}`}>
                {c}
              </span>
            ))}
          </div>
          <h3 data-reveal style={stagger(1)} className="display mt-6 text-[32px] leading-10 md:text-[40px] md:leading-[48px]">
            A worked example: chest X-ray, five labels, one sentence
          </h3>
          <p data-reveal style={stagger(2)} className="mt-6 max-w-[560px] text-ui text-ink/80">
            We typed “Chest X-ray classification with five labels: normal, pneumonia, effusion, nodule, other” into an empty {NAME} and
            dropped in 20 images. The assistant read the file facts, booted the Studio and added the labels. Then a person did the
            labelling.
          </p>
          <p data-reveal style={stagger(3)} className="mt-auto pt-8 text-caption text-ink/50">
            Measured on local runs in November 2026 with a small hosted model. Synthetic and public images only.
          </p>
        </div>
        <ul className="grid gap-1">
          {CASE_STATS.map((s, i) => (
            <li key={s.value} data-reveal style={stagger(i + 1)} className="rounded-[30px] bg-violet p-[30px] text-white">
              <div className="display text-[40px] leading-[48px]">{s.value}</div>
              <p className="mt-1 text-ui text-white/85">{s.text}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Stat({ value, suffix, label, start, i }: (typeof STATS)[number] & { start: boolean; i: number }) {
  const n = useCountUp(value, start, 1200 + i * 200);
  return (
    <li className="flex flex-col items-center gap-2 px-6 text-center not-first:border-ink/15 lg:not-first:border-l">
      <span className="display text-h2 tabular-nums">
        {Math.round(n)}
        {suffix}
      </span>
      <span className="max-w-[220px] text-caption">{label}</span>
    </li>
  );
}

export function Stats() {
  const ref = useReveal<HTMLElement>();
  const band = useRef<HTMLUListElement>(null);
  const start = useInView(band, { once: true });
  return (
    <section ref={ref} className="shell py-12">
      <h2 data-reveal className="text-[36px] leading-[1.1] md:text-h2">
        Made for real research data
      </h2>
      <ul ref={band} data-reveal style={stagger(1)} className="mt-10 grid gap-y-10 rounded-card bg-lime py-12 sm:grid-cols-2 lg:grid-cols-4">
        {STATS.map((s, i) => (
          <Stat key={s.label} {...s} i={i} start={start} />
        ))}
      </ul>
    </section>
  );
}

export function Privacy() {
  const ref = useReveal<HTMLElement>();
  return (
    <section ref={ref} className="shell py-12">
      <div className="grid items-center gap-8 border-y border-line py-12 md:grid-cols-[auto_1fr]">
        <div data-reveal className="flex size-24 items-center justify-center rounded-3xl bg-ink text-lime">
          <LockIcon className="size-10" />
        </div>
        <div>
          <p data-reveal style={stagger(1)} className="text-[28px] leading-9 font-semibold md:text-h3">
            Your files never reach the model
          </p>
          <p data-reveal style={stagger(2)} className="mt-3 max-w-[760px]">
            The assistant works from file names and facts: counts, sizes, formats, dimensions. Pixels, samples and text stay in your
            project’s storage, in a separate cloud project from where the assistant runs.
          </p>
        </div>
      </div>
    </section>
  );
}
