import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { AiIcon, BoxIcon, CheckIcon, PanIcon, RedoIcon, SelectIcon, SubmitIcon, ToolIcon, UndoIcon, ZoomInIcon } from "@studio/ui/icons";
import { NAME } from "@/content";
import { useInView, useReducedMotion } from "@/lib/motion";
import { Xray } from "./scenes";

/**
 * The hero's product demo: one clock drives a scripted first run, and every element derives its
 * state from the current time. Home composer → assistant tool steps → Studio boots → a person labels.
 */

const LOOP = 15;
const STILL = 9.4; // the frame shown under reduced motion
const PROMPT = "Chest X-ray classification with five labels";
const REPLY = "Your Studio is ready with five labels. The first image is open.";
const LABELS = ["Normal", "Pneumonia", "Effusion", "Nodule", "Other"];
const TOOLS = [
  { text: "Read file facts · 20 images", start: 2.9, done: 3.6 },
  { text: "Boot Studio · classification", start: 3.7, done: 4.6 },
  { text: "Add labels · 5", start: 4.7, done: 5.6 },
];
/** Items the person labels: when each opens, which label, and when the label lands. */
const ITEMS = [
  { open: 3.9, label: 2, at: 9.0, variant: 0 },
  { open: 9.8, label: 1, at: 10.9, variant: 1 },
  { open: 11.7, label: 0, at: 12.6, variant: 2 },
];

const clamp = (x: number) => Math.max(0, Math.min(1, x));
const span = (t: number, a: number, b: number) => clamp((t - a) / (b - a));
const ease = (x: number) => 1 - Math.pow(1 - x, 3);
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

function useClock(ref: RefObject<HTMLElement | null>) {
  const visible = useInView(ref, { margin: "0px" });
  const reduced = useReducedMotion();
  const [t, setT] = useState(reduced ? STILL : 0);
  const origin = useRef<number | null>(null);
  const offset = useRef(0);
  useEffect(() => {
    if (reduced) return setT(STILL);
    if (!visible) return;
    let raf = 0;
    let shown = -1;
    const tick = (now: number) => {
      if (origin.current === null) origin.current = now - offset.current * 1000;
      const next = ((now - origin.current) / 1000) % LOOP;
      if (Math.abs(next - shown) > 1 / 30) setT((shown = next));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      offset.current = shown < 0 ? 0 : shown;
      origin.current = null;
    };
  }, [visible, reduced]);
  return t;
}

function Spinner() {
  return <span className="block size-3.5 rounded-full border-2 border-violet/25 border-t-violet" style={{ animation: "spin 0.8s linear infinite" }} />;
}

function Fade({ show, children, className = "" }: { show: number; children: ReactNode; className?: string }) {
  return (
    <div className={className} style={{ opacity: show, transform: `translateY(${(1 - show) * 6}px)` }}>
      {children}
    </div>
  );
}

function Home({ t }: { t: number }) {
  const typed = PROMPT.slice(0, Math.round(span(t, 0.5, 2.1) * PROMPT.length));
  const ready = typed.length === PROMPT.length;
  const pressed = t > 2.15 && t < 2.35;
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-white px-8" style={{ opacity: 1 - span(t, 2.3, 2.7), pointerEvents: "none" }}>
      <div className="display text-[22px]">What are you working on?</div>
      <div className="w-full max-w-[400px] rounded-xl border border-line bg-white p-3 shadow-[0_8px_30px_-12px_rgb(5_43_66/25%)]">
        <div className="min-h-10 text-[13px]">
          {typed || <span className="text-ink/35">Describe a task or drop files</span>}
          {!ready && <span className="animate-caret ml-px inline-block h-4 w-px translate-y-0.5 bg-ink" />}
        </div>
        <div className="flex justify-end">
          <span className={`flex size-7 items-center justify-center rounded-lg transition-colors ${ready ? "bg-ink text-white" : "bg-wash text-ink/40"} ${pressed ? "scale-90" : ""}`}>
            <SubmitIcon className="size-3.5" />
          </span>
        </div>
      </div>
    </div>
  );
}

function Assistant({ t }: { t: number }) {
  const reply = REPLY.slice(0, Math.round(span(t, 5.9, 7.2) * REPLY.length));
  return (
    <aside className="hidden w-[208px] shrink-0 flex-col border-l border-line bg-[rgb(250_250_251)] sm:flex">
      <div className="flex h-9 items-center border-b border-line px-3 text-[12px] font-semibold">Chest X-ray classification</div>
      <div className="flex flex-1 flex-col justify-end gap-3 overflow-hidden p-3 text-[11.5px] leading-4">
        <Fade show={ease(span(t, 2.4, 2.8))} className="ml-auto max-w-[90%] rounded-lg bg-wash px-2.5 py-2">
          {PROMPT}
        </Fade>
        <Fade show={ease(span(t, 2.6, 2.9))} className="flex items-center gap-1.5 text-[10px] font-semibold tracking-wider text-ink/45 uppercase">
          <AiIcon className="size-3 text-violet" /> {NAME} AI
        </Fade>
        <ul className="space-y-1">
          {TOOLS.map((s) => (
            <li key={s.text} className="flex h-6 items-center gap-2 rounded-md px-1" style={{ opacity: ease(span(t, s.start, s.start + 0.25)) }}>
              <ToolIcon className="size-3 shrink-0 text-ink/40" />
              <span className="flex-1 truncate">{s.text}</span>
              {t < s.done ? <Spinner /> : <CheckIcon className="size-3.5 text-[rgb(0,150,80)]" />}
            </li>
          ))}
        </ul>
        <div className="min-h-8">{reply}</div>
      </div>
      <div className="m-2 rounded-lg border border-line bg-white px-2.5 py-2 text-[11px] text-ink/35">Ask anything…</div>
    </aside>
  );
}

function Cursor({ t }: { t: number }) {
  // Box drag on the first item: approach, press, drag, release, leave.
  const keys: [number, number, number][] = [
    [7.0, 92, 98],
    [7.7, 60, 72],
    [8.6, 81, 89],
    [9.3, 94, 104],
  ];
  if (t < keys[0][0] || t > keys[keys.length - 1][0]) return null;
  let i = 0;
  while (i < keys.length - 2 && t > keys[i + 1][0]) i++;
  const k = ease(span(t, keys[i][0], keys[i + 1][0]));
  const x = lerp(keys[i][1], keys[i + 1][1], k);
  const y = lerp(keys[i][2], keys[i + 1][2], k);
  return (
    <svg className="pointer-events-none absolute z-10 size-4 drop-shadow" style={{ left: `${x}%`, top: `${y}%`, opacity: 1 - span(t, 9.0, 9.3) }} viewBox="0 0 16 16" aria-hidden>
      <path d="M2 1l11 6.5-5 1.2-2.3 4.8z" fill="white" stroke="rgb(5,43,66)" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

function Viewer({ t }: { t: number }) {
  const item = ITEMS.reduce((cur, it, i) => (t >= it.open ? i : cur), 0);
  const current = ITEMS[item];
  const booted = span(t, 3.9, 4.4);
  const drag = ease(span(t, 7.7, 8.6));
  const boxShown = item === 0 && t >= 7.7;
  const tagged = t >= current.at;
  const keyHint = item > 0 && t > current.at - 0.35 && t < current.at + 0.5;
  return (
    <div className="relative min-w-0 flex-1 overflow-hidden bg-[#1a1d22]">
      <div className="absolute inset-0 animate-pulse bg-[#22262c]" style={{ opacity: 1 - booted }} />
      <div key={item} className="absolute inset-0 flex items-center justify-center" style={{ opacity: item === 0 ? booted : ease(span(t, current.open, current.open + 0.35)) }}>
        <div className="aspect-square h-full">
          <Xray variant={current.variant} />
        </div>
      </div>
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="relative aspect-square h-full">
          {boxShown && (
            <div
              className="absolute rounded-[3px] border-2 border-lime bg-lime/15"
              style={{ left: "60%", top: "72%", width: `${drag * 21}%`, height: `${drag * 17}%` }}
            >
              {t >= 8.7 && <span className="animate-fade-up absolute -top-5 left-0 rounded bg-lime px-1 text-[10px] leading-4 font-semibold text-ink">Effusion</span>}
            </div>
          )}
          <Cursor t={t} />
        </div>
      </div>
      {item > 0 && tagged && (
        <span className="animate-fade-up absolute top-2.5 left-2.5 rounded-md bg-lime px-1.5 py-0.5 text-[10px] font-semibold text-ink">{LABELS[current.label]}</span>
      )}
      {keyHint && (
        <span className="animate-fade-up absolute right-3 bottom-3 flex size-7 items-center justify-center rounded-md border border-white/30 bg-white/10 text-[12px] font-semibold text-white">
          {current.label + 1}
        </span>
      )}
      <span className="absolute right-2.5 top-2.5 font-mono text-[9px] text-white/45" style={{ opacity: booted }}>
        {item + 1} / 20
      </span>
    </div>
  );
}

function Studio({ t }: { t: number }) {
  const item = ITEMS.reduce((cur, it, i) => (t >= it.open ? i : cur), 0);
  const done = ITEMS.filter((it) => t >= it.at).length;
  const activeLabel = ITEMS.find((it) => t >= it.at && t < it.at + 0.9)?.label;
  const tool = t >= 7.6 && t < 9.2 ? "box" : "select";
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex h-9 items-center gap-1 border-b border-line px-2">
        {[
          ["select", SelectIcon],
          ["pan", PanIcon],
          ["box", BoxIcon],
          ["zoom", ZoomInIcon],
        ].map(([id, Icon]) => {
          const I = Icon as typeof SelectIcon;
          return (
            <span key={id as string} className={`flex size-6 items-center justify-center rounded-md ${tool === id ? "bg-ink text-white" : "text-ink/55"}`}>
              <I className="size-3.5" />
            </span>
          );
        })}
        <span className="mx-1 h-4 w-px bg-line" />
        <UndoIcon className="size-3.5 text-ink/30" />
        <RedoIcon className="ml-1.5 size-3.5 text-ink/30" />
        <span className="ml-auto flex items-center gap-2 text-[11px] text-ink/60 tabular-nums">
          {done} / 20 labelled
          <span className="h-1 w-14 overflow-hidden rounded-full bg-skeleton">
            <span className="block h-full bg-violet transition-[width] duration-500" style={{ width: `${(done / 20) * 100}%` }} />
          </span>
        </span>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex w-12 shrink-0 flex-col gap-1.5 border-r border-line p-1.5">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              className={`aspect-square overflow-hidden rounded ${i === item ? "ring-2 ring-violet" : "brightness-[0.6]"}`}
              style={{ opacity: span(t, 3.9 + i * 0.08, 4.2 + i * 0.08) }}
            >
              <Xray variant={i % 3} />
            </div>
          ))}
        </div>
        <Viewer t={t} />
      </div>
      <div className="flex h-11 items-center gap-1.5 overflow-hidden border-t border-line px-2">
        {LABELS.map((l, i) => {
          const show = ease(span(t, 4.8 + i * 0.15, 5.1 + i * 0.15));
          const on = activeLabel === i;
          return (
            <span
              key={l}
              className={`flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[11px] transition-colors duration-200 ${on ? "bg-lime font-semibold" : "bg-mist"}`}
              style={{ opacity: show, transform: `translateY(${(1 - show) * 8}px)` }}
            >
              <kbd className={`flex size-4 items-center justify-center rounded text-[9px] ${on ? "bg-ink/15" : "bg-white"}`}>{i + 1}</kbd>
              {l}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function StudioDemo() {
  const ref = useRef<HTMLDivElement>(null);
  const t = useClock(ref);
  const out = span(t, LOOP - 0.6, LOOP);
  return (
    <div ref={ref} className="relative w-full overflow-hidden rounded-[20px] border border-line bg-white shadow-[0_40px_80px_-32px_rgb(5_43_66/35%)]" aria-label={`${NAME} setting up a Studio from one sentence`} role="img">
      <div className="flex h-9 items-center gap-1.5 border-b border-line bg-[rgb(250_250_251)] px-3.5">
        <span className="size-2.5 rounded-full bg-ink/15" />
        <span className="size-2.5 rounded-full bg-ink/15" />
        <span className="size-2.5 rounded-full bg-ink/15" />
        <span className="mx-auto rounded-md bg-wash px-3 py-0.5 text-[11px] text-ink/50">{t < 2.5 ? "Home" : "Chest X-ray · Studio"}</span>
      </div>
      <div className="relative flex h-[400px]" style={{ opacity: 1 - out }}>
        <div className="flex min-w-0 flex-1" style={{ opacity: span(t, 2.4, 2.8) }}>
          <Studio t={t} />
          <Assistant t={t} />
        </div>
        {t < 2.7 && <Home t={t} />}
      </div>
    </div>
  );
}
