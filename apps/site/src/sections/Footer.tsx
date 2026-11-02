import { ArrowRightIcon } from "@studio/ui/icons";
import { APP_URL, FOOTER, NAME } from "@/content";
import { stagger, useReveal } from "@/lib/motion";
import { Logo } from "./Header";

const LANE_COLORS = ["var(--color-lime)", "var(--color-violet)", "var(--color-sky)", "white", "var(--color-lilac)"];

/** The hero's labelled lanes, frozen: five rows of tiles with gaps, denser toward the right. */
const TILES = Array.from({ length: 5 * 30 }, (_, i) => {
  const row = Math.floor(i / 30);
  const col = i % 30;
  const hash = Math.sin(i * 12.9898) * 43758.5453;
  const r = hash - Math.floor(hash);
  return [col * 25, 20 + row * 44, LANE_COLORS[row], r < col / 34 ? 0.2 : 0] as const;
}).filter((t) => t[3] > 0);

export function Footer() {
  const ref = useReveal<HTMLElement>();
  return (
    <footer id="start" ref={ref} className="relative overflow-hidden bg-ink text-white">
      <svg aria-hidden className="pointer-events-none absolute top-10 right-0 h-[240px] w-[760px] [mask-image:linear-gradient(90deg,transparent,black_60%)]" viewBox="0 0 760 240" fill="none">
        {TILES.map(([x, y, c, o], i) => (
          <rect key={i} x={x} y={y} width="14" height="14" rx="3" fill={c} opacity={o} />
        ))}
      </svg>
      <div className="relative shell pt-24 pb-16">
        <div className="flex flex-col items-start gap-8 md:flex-row md:items-center md:justify-between">
          <h2 data-reveal className="max-w-[640px] text-[36px] leading-[1.1] md:text-h2">
            Start your first dataset today
          </h2>
          <a data-reveal style={stagger(1)} href={APP_URL} className="btn h-[60px] w-[260px] bg-lime text-[20px] text-ink hover:bg-lime-soft">
            Start for free <ArrowRightIcon className="size-5" />
          </a>
        </div>
        <div className="mt-16 h-px bg-white/20" />
        <div className="mt-12 grid gap-10 md:grid-cols-[1.4fr_repeat(4,1fr)]">
          <div className="flex flex-col gap-4">
            <Logo inverse />
            <p className="max-w-[260px] text-ui text-white/60">The data studio for people who know the data.</p>
          </div>
          {FOOTER.map((col) => (
            <div key={col.title}>
              <h3 className="text-ui font-semibold text-white/85">{col.title}</h3>
              <ul className="mt-4 space-y-4">
                {col.links.map((l) => (
                  <li key={l}>
                    <a href="#top" className="text-ui text-white/50 transition-colors hover:text-white">
                      {l}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="mt-16 flex flex-wrap items-center justify-between gap-4 border-t border-white/10 pt-6 text-caption text-white/40">
          <span>
            © {new Date().getFullYear()} {NAME}
          </span>
          <span className="flex gap-6">
            <a href="#top" className="hover:text-white">
              Privacy
            </a>
            <a href="#top" className="hover:text-white">
              Terms
            </a>
            <a href="#top" className="hover:text-white">
              Security
            </a>
          </span>
        </div>
      </div>
    </footer>
  );
}
