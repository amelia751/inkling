// The app proper, imported by main.tsx once the runtime config (/config.json) is loaded, so
// module manifests, flags and the kernel switch see the final settings.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@studio/ui/ui/tooltip";
import { ThemeProvider, useTheme } from "@/studio/lib/theme";
import { Toaster } from "@studio/ui/ui/sonner";
import { LiveRegion } from "@/studio/lib/files/announce";
import "@/extension-host/bundled";
import { AppShell } from "@/studio/app/AppShell";
import { SessionGate } from "@/studio/components/layout/session-gate";
import { installSessionHandlers, sessionCaches } from "@/studio/lib/session";

// A 401 from any API call (the shared fetch) or any query or mutation sends a signed-out person
// to sign in again (workos mode only; todo9 Phase 4).
installSessionHandlers();
const queryClient = new QueryClient({ ...sessionCaches(), defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

/** One toaster for the whole app (todo7 §2 Feedback), following the theme. */
function ThemedToaster() {
  return <Toaster theme={useTheme().theme} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={300}>
          <SessionGate>
            <AppShell />
          </SessionGate>
          <ThemedToaster />
          <LiveRegion />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
