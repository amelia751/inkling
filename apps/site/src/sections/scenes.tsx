import { useId, type CSSProperties, type ReactNode } from "react";
import { AiIcon, ArchiveFileIcon, CheckIcon, FileIcon, ImageIcon, TableFileIcon, ToolIcon, UploadIcon } from "@studio/ui/icons";
import { NAME } from "@/content";

const delay = (s: number): CSSProperties => ({ animationDelay: `${s}s` });

function Window({ title, children, className = "" }: { title: string; children: ReactNode; className?: string }) {
  return (
    <div className={`w-full overflow-hidden rounded-[20px] border border-line bg-white shadow-[0_24px_60px_-24px_rgb(5_43_66/30%)] ${className}`}>
      <div className="flex h-9 items-center gap-1.5 border-b border-line px-4">
        <span className="size-2.5 rounded-full bg-ink/15" />
        <span className="size-2.5 rounded-full bg-ink/15" />
        <span className="size-2.5 rounded-full bg-ink/15" />
        <span className="ml-3 text-caption text-ink/50">{title}</span>
      </div>
      {children}
    </div>
  );
}

const FILES = [
  { icon: ImageIcon, name: "chest_0001.png", size: "1.2 MB" },
  { icon: ImageIcon, name: "chest_0002.png", size: "1.1 MB" },
  { icon: ArchiveFileIcon, name: "ct_abdomen_series.zip", size: "212 MB" },
  { icon: TableFileIcon, name: "ecg_lead_II.csv", size: "4.8 MB" },
  { icon: FileIcon, name: "readme.txt", size: "2 KB" },
];

export function SceneDrop() {
  return (
    <Window title="Files · New project">
      <div className="p-5">
        <div className="animate-fade-up flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-violet/30 bg-lilac/40 py-6 text-center">
          <UploadIcon className="size-6 text-violet" />
          <span className="text-ui font-semibold">Drop files or folders</span>
          <span className="text-caption text-ink/50">DICOM, images, ZIP, CSV, video</span>
        </div>
        <ul className="mt-4 space-y-1.5">
          {FILES.map((f, i) => (
            <li key={f.name} className="animate-fade-up flex items-center gap-3 rounded-xl px-3 py-2 odd:bg-mist" style={delay(0.4 + i * 0.35)}>
              <f.icon className="size-4 shrink-0 text-ink/60" />
              <span className="min-w-0 flex-1 truncate text-caption font-medium">{f.name}</span>
              <span className="text-caption text-ink/40">{f.size}</span>
              <span className="relative h-1 w-16 overflow-hidden rounded-full bg-skeleton">
                <span className="absolute inset-0 origin-left bg-violet" style={{ animation: `progress 1.1s var(--ease-out-soft) ${0.6 + i * 0.35}s both` }} />
              </span>
              <CheckIcon className="animate-fade-up size-4 text-[rgb(0,150,80)]" style={delay(1.8 + i * 0.35)} />
            </li>
          ))}
        </ul>
      </div>
    </Window>
  );
}

const TOOLS = ["Read file facts · 20 images", "Plan dataset · Chest X-ray", "Boot Studio · classification", "Add labels · 5"];

export function SceneAsk() {
  const prompt = "Chest X-ray classification with five labels";
  return (
    <Window title={`${NAME} assistant`}>
      <div className="flex flex-col gap-4 p-5">
        <div className="ml-auto max-w-[85%] rounded-xl bg-mist px-3.5 py-2.5 text-ui">
          <span className="inline-block overflow-hidden align-bottom whitespace-nowrap" style={{ animation: `type-in 1.6s steps(${prompt.length}) both`, ["--chars" as string]: `${prompt.length}ch` }}>
            {prompt}
          </span>
        </div>
        <div className="flex items-center gap-2 text-caption font-semibold tracking-wider text-ink/50 uppercase animate-fade-up" style={delay(1.8)}>
          <AiIcon className="size-4 text-violet" /> {NAME} AI
        </div>
        <ul className="space-y-1">
          {TOOLS.map((t, i) => (
            <li key={t} className="animate-fade-up flex h-8 items-center gap-2.5 rounded-lg px-2 text-caption" style={delay(2.1 + i * 0.6)}>
              <ToolIcon className="size-4 text-ink/40" />
              <span className="flex-1">{t}</span>
              <span className="relative size-4">
                <span className="absolute inset-0 rounded-full border-2 border-violet/25 border-t-violet" style={{ animation: `spin 0.8s linear infinite, fade-out 0.1s ${2.6 + i * 0.6}s forwards` }} />
                <CheckIcon className="animate-fade-up absolute inset-0 size-4 text-[rgb(0,150,80)]" style={delay(2.65 + i * 0.6)} />
              </span>
            </li>
          ))}
        </ul>
        <p className="animate-fade-up text-ui" style={delay(4.8)}>
          Your Studio is open with <b>normal, pneumonia, effusion, nodule</b> and <b>other</b>. The first image is ready to label.
        </p>
      </div>
    </Window>
  );
}

const LABELS = ["Normal", "Pneumonia", "Effusion", "Nodule", "Other"];

/** A drawn chest X-ray (no real image bytes on the page): 0 effusion at the right base, 1 a hazy left lung, 2 clear. */
export function Xray({ variant = 0 }: { variant?: number }) {
  const id = useId();
  return (
    <svg viewBox="0 0 240 240" className="size-full" aria-hidden>
      <defs>
        <radialGradient id={`${id}l`} cx="50%" cy="45%" r="60%">
          <stop offset="0" stopColor="#111" />
          <stop offset="1" stopColor="#333" />
        </radialGradient>
        <linearGradient id={`${id}b`} x1="0" x2="1">
          <stop offset="0" stopColor="#9aa" stopOpacity="0.15" />
          <stop offset="0.5" stopColor="#dde" stopOpacity="0.55" />
          <stop offset="1" stopColor="#9aa" stopOpacity="0.15" />
        </linearGradient>
      </defs>
      <rect width="240" height="240" fill="#1a1d22" />
      <path d="M40 220 C30 140 50 60 110 40 L130 40 C190 60 210 140 200 220Z" fill="#3a3f47" />
      <path d="M58 200 C50 140 62 80 108 62 L110 196Z" fill={`url(#${id}l)`} />
      <path d="M182 200 C190 140 178 80 132 62 L130 196Z" fill={`url(#${id}l)`} />
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <g key={i} stroke={`url(#${id}b)`} strokeWidth="5" fill="none" strokeLinecap="round">
          <path d={`M110 ${76 + i * 20} C88 ${70 + i * 20} 66 ${80 + i * 21} 56 ${98 + i * 21}`} />
          <path d={`M130 ${76 + i * 20} C152 ${70 + i * 20} 174 ${80 + i * 21} 184 ${98 + i * 21}`} />
        </g>
      ))}
      <rect x="112" y="40" width="16" height="170" rx="6" fill="#cfd4da" opacity="0.35" />
      <ellipse cx="138" cy="160" rx="34" ry="30" fill="#c9ced6" opacity="0.32" />
      {variant === 0 && <path d="M150 196 C160 186 176 184 186 190 L186 206 L150 206Z" fill="#c9ced6" opacity="0.4" />}
      {variant === 1 && <ellipse cx="82" cy="138" rx="24" ry="34" fill="#c9ced6" opacity="0.28" />}
    </svg>
  );
}

export function SceneStudio() {
  return (
    <Window title="Studio · Chest X-ray classification">
      <div className="grid grid-cols-[64px_1fr_150px]">
        <div className="space-y-2 border-r border-line p-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className={`aspect-square overflow-hidden rounded-md animate-fade-up ${i === 0 ? "ring-2 ring-violet ring-offset-1" : "opacity-60"}`} style={delay(0.1 + i * 0.1)}>
              <Xray />
            </div>
          ))}
        </div>
        <div className="relative aspect-square bg-[#1a1d22]">
          <Xray />
          <svg viewBox="0 0 240 240" className="absolute inset-0 size-full" aria-hidden>
            <rect x="146" y="168" width="48" height="40" rx="3" fill="rgb(224 255 79 / 0.12)" stroke="var(--color-lime)" strokeWidth="2" pathLength="600" className="animate-draw" style={{ animationDelay: "1.2s" }} />
          </svg>
          <span className="animate-fade-up absolute top-[63%] right-[19%] rounded-md bg-lime px-1.5 py-0.5 text-[11px] font-semibold" style={delay(2.4)}>
            Effusion
          </span>
        </div>
        <div className="space-y-1 p-3">
          <div className="mb-2 text-caption font-semibold">Labels</div>
          {LABELS.map((l, i) => (
            <div
              key={l}
              className="animate-fade-up flex h-7 items-center gap-2 rounded-lg px-2 text-caption"
              style={{ ...delay(0.3 + i * 0.12), ...(l === "Effusion" ? { animation: `fade-up 450ms var(--ease-out-soft) ${0.3 + i * 0.12}s both, pick 0.3s 2.3s forwards` } : {}) }}
            >
              <kbd className="flex size-4 items-center justify-center rounded bg-skeleton text-[10px]">{i + 1}</kbd>
              {l}
            </div>
          ))}
        </div>
      </div>
    </Window>
  );
}

const NODES = [
  { x: 40, y: 70, label: "v1", note: "1,200 items" },
  { x: 150, y: 70, label: "v2", note: "+3,412 labels" },
  { x: 205, y: 150, label: "second-reader", note: "214 changed" },
  { x: 330, y: 70, label: "v3", note: "merged · κ 0.87" },
];

export function SceneVersions() {
  return (
    <Window title="Datasets · Chest X-ray · Versions">
      <div className="p-5">
        <svg viewBox="0 10 400 200" className="w-full" aria-hidden>
          <path d="M40 70 H330" stroke="var(--color-ink)" strokeOpacity="0.25" strokeWidth="2" pathLength="600" className="animate-draw" />
          <path d="M150 70 C175 70 180 150 205 150 C250 150 290 70 330 70" stroke="var(--color-violet)" strokeWidth="2" fill="none" pathLength="600" className="animate-draw" style={{ animationDelay: "0.8s" }} />
          {NODES.map((n, i) => (
            <g key={n.label} className="animate-fade-up" style={delay(0.3 + i * 0.5)}>
              <circle cx={n.x} cy={n.y} r="9" fill={i === 2 ? "var(--color-violet)" : i === 3 ? "var(--color-lime)" : "white"} stroke="var(--color-ink)" strokeWidth="2" />
              <text x={n.x} y={i === 2 ? n.y + 30 : n.y - 34} textAnchor="middle" className="fill-ink text-[13px] font-semibold">
                {n.label}
              </text>
              <text x={n.x} y={i === 2 ? n.y + 46 : n.y - 18} textAnchor="middle" className="fill-ink/50 text-[11px]">
                {n.note}
              </text>
            </g>
          ))}
        </svg>
        <div className="animate-fade-up mt-2 flex items-center justify-between rounded-xl bg-mist px-4 py-3" style={delay(2.6)}>
          <span className="text-caption">
            <b>v3</b> is ready to cite
          </span>
          <span className="rounded-lg bg-ink px-3 py-1.5 text-caption font-medium text-white">Export</span>
        </div>
      </div>
    </Window>
  );
}

export const SCENES = [SceneDrop, SceneAsk, SceneStudio, SceneVersions];
