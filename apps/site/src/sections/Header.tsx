import { useEffect, useState } from "react";
import { ArrowRightIcon, BrandLogo, ChevronDownIcon, CloseIcon, MenuIcon } from "@studio/ui/icons";
import { ANNOUNCEMENTS, APP_URL, NAME, NAV, type NavEntry } from "@/content";
import { useCycle, useReducedMotion } from "@/lib/motion";

export function Logo({ inverse = false }: { inverse?: boolean }) {
  return (
    <a href="/#top" className="flex items-center gap-2.5" aria-label={`${NAME} home`}>
      <BrandLogo className="size-9 shrink-0" />
      <span className={`display text-[22px] tracking-[-0.02em] ${inverse ? "text-white" : "text-ink"}`}>{NAME}</span>
    </a>
  );
}

function Stripe() {
  const reduced = useReducedMotion();
  const [i] = useCycle(ANNOUNCEMENTS.length, 5000, !reduced);
  return (
    <div className="relative h-10 overflow-hidden bg-lilac">
      <a key={i} href="#news" className="animate-ticker-in shell flex h-10 items-center justify-center gap-2 text-caption font-medium hover:underline">
        <span className="truncate">{ANNOUNCEMENTS[i]}</span>
        <ArrowRightIcon className="size-3.5 shrink-0" />
      </a>
    </div>
  );
}

function NavItem({ entry }: { entry: NavEntry }) {
  if (!entry.menu)
    return (
      <a href={entry.href} className="flex h-9 items-center rounded-lg px-3 text-ui font-medium hover:bg-wash">
        {entry.label}
      </a>
    );
  return (
    <div className="group relative">
      <a href={entry.href} className="flex h-9 items-center gap-1 rounded-lg px-3 text-ui font-medium group-hover:bg-wash">
        {entry.label}
        <ChevronDownIcon className="size-3.5 transition-transform duration-200 group-hover:rotate-180" />
      </a>
      <div className="invisible absolute top-full left-0 pt-2 opacity-0 transition-[opacity,translate] duration-200 group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:translate-y-0 group-hover:opacity-100 translate-y-1">
        <div className="grid w-[520px] grid-cols-2 gap-1 rounded-card border border-line bg-white p-3 shadow-[0_16px_48px_-12px_rgb(5_43_66/25%)]">
          {entry.menu.map((m) => (
            <a key={m.title} href={entry.href} className="flex gap-3 rounded-2xl p-3 hover:bg-mist">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-lilac text-violet">
                <m.icon className="size-4" />
              </span>
              <span>
                <span className="block text-ui font-semibold">{m.title}</span>
                <span className="block text-caption text-ink/60">{m.text}</span>
              </span>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}

export function Header() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(scrollY > 40);
    on();
    addEventListener("scroll", on, { passive: true });
    return () => removeEventListener("scroll", on);
  }, []);

  return (
    <>
      <Stripe />
      <header
        className={`sticky top-0 z-40 transition-[background-color,box-shadow] duration-300 ${
          scrolled ? "bg-white/85 shadow-[0_1px_0_var(--color-line)] backdrop-blur-xl" : "bg-transparent"
        }`}
      >
        <div className="shell flex h-16 items-center gap-6">
          <Logo />
          <nav className="hidden items-center gap-1 lg:flex">
            {NAV.map((n) => (
              <NavItem key={n.label} entry={n} />
            ))}
          </nav>
          <div className="ml-auto hidden items-center gap-2 sm:flex">
            <a href="#start" className="flex h-9 items-center rounded-control px-4 text-ui font-medium hover:bg-wash">
              Contact us
            </a>
            <a href={APP_URL} className="flex h-9 items-center rounded-control bg-ink px-4 text-ui font-medium text-white hover:bg-ink-raised">
              Sign in
            </a>
          </div>
          <button className="ml-auto flex size-10 items-center justify-center rounded-control hover:bg-wash lg:hidden sm:ml-0" aria-label="Menu" onClick={() => setOpen((o) => !o)}>
            {open ? <CloseIcon className="size-5" /> : <MenuIcon className="size-5" />}
          </button>
        </div>
        {open && (
          <nav className="animate-fade-up shell flex flex-col gap-1 border-t border-line bg-white pb-4 lg:hidden">
            {NAV.map((n) => (
              <a key={n.label} href={n.href} onClick={() => setOpen(false)} className="flex h-12 items-center text-lead font-semibold">
                {n.label}
              </a>
            ))}
            <a href={APP_URL} className="btn-primary mt-2">
              Sign in
            </a>
          </nav>
        )}
      </header>
    </>
  );
}
