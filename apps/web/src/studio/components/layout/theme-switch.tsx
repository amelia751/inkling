import type { ReactNode } from "react";
import { DarkThemeIcon, LightThemeIcon, SystemThemeIcon } from "@studio/ui/icons";
import { SegmentedControl } from "@studio/ui/ui/segmented-control";
import { useTheme, type ThemePreference } from "@/studio/lib/theme";

const OPTIONS = [
  { value: "light", label: <LightThemeIcon />, title: "Light", "aria-label": "Light theme" },
  { value: "system", label: <SystemThemeIcon />, title: "Match system", "aria-label": "Match system theme" },
  { value: "dark", label: <DarkThemeIcon />, title: "Dark", "aria-label": "Dark theme" },
] as const satisfies readonly { value: ThemePreference; label: ReactNode; title: string; "aria-label": string }[];

/** Light / system / dark, as in the Nebius console header. */
export function ThemeSwitch({ className }: { className?: string }) {
  const { preference, setPreference } = useTheme();
  return (
    <SegmentedControl
      variant="outline"
      size="md"
      aria-label="Theme"
      value={preference}
      onValueChange={setPreference}
      options={OPTIONS}
      className={className}
    />
  );
}
