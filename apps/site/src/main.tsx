import "./lib/runtime";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/manrope";
import "./site.css";
import { legalKind } from "@studio/contracts/legal";
import { App } from "./App";
import { Legal } from "./sections/Legal";

// nginx answers every path with index.html; /privacy and /terms are the only other pages.
const legal = legalKind(window.location.pathname);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {legal ? <Legal kind={legal} /> : <App />}
  </StrictMode>,
);
