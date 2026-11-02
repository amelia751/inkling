import { Builders } from "./sections/Builders";
import { Footer } from "./sections/Footer";
import { Header } from "./sections/Header";
import { Hero } from "./sections/Hero";
import { Journey } from "./sections/Journey";
import { DataTypes, Example } from "./sections/Proof";

export function App() {
  return (
    <>
      <a href="#journey" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-control focus:bg-white focus:p-3">
        Skip to content
      </a>
      {/* Hidden for a minimal page; components kept: AssistantBanner, Stats, Privacy (Proof.tsx), News. */}
      <Header />
      <main>
        <Hero />
        <Journey />
        <DataTypes />
        <Builders />
        <Example />
      </main>
      <Footer />
    </>
  );
}
