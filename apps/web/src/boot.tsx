// The app proper, imported by main.tsx once the runtime config (/config.json) is loaded, so
// module manifests, flags and the kernel switch see the final settings.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@studio/studio-ui/ui/tooltip";
import { ThemeProvider } from "@/studio/lib/theme";
import "@/extension-host/bundled";
import { AppShell } from "@/studio/app/AppShell";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={300}>
          <AppShell />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
