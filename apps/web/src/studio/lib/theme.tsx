import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { usePersonPref } from "@/studio/lib/person-prefs";

export type Theme = "light" | "dark";
export type ThemePreference = Theme | "system";

/** The cache key (device-wide, so the first paint before sign-in has the theme); the server key is `theme` (todo22 D3). */
const STORAGE_KEY = "app-theme";
const PREF = "theme";
const PREF_OPTS = { cache: STORAGE_KEY, raw: true };
const DARK_QUERY = "(prefers-color-scheme: dark)";

const ThemeContext = createContext<
  { preference: ThemePreference; theme: Theme; setPreference: (p: ThemePreference) => void } | undefined
>(undefined);

const isPreference = (v: unknown): v is ThemePreference => v === "light" || v === "dark" || v === "system";

/** Colors live in styles/globals.css; this only sets the `.light`/`.dark` class and persists the choice. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [saved, setPreference] = usePersonPref<ThemePreference>(PREF, "dark", PREF_OPTS);
  const preference: ThemePreference = isPreference(saved) ? saved : "dark";
  const [systemDark, setSystemDark] = useState(() => window.matchMedia(DARK_QUERY).matches);

  useEffect(() => {
    const mq = window.matchMedia(DARK_QUERY);
    const on = () => setSystemDark(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const theme: Theme = preference === "system" ? (systemDark ? "dark" : "light") : preference;

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(theme);
    root.style.colorScheme = theme;
  }, [theme]);

  return <ThemeContext.Provider value={{ preference, theme, setPreference }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside ThemeProvider");
  return ctx;
}
