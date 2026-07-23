"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Header } from "@/components/header";
import { ScribeView } from "@/components/scribe/scribe-view";
import { CriticView } from "@/components/critic/critic-view";
import { CrossDomainView } from "@/components/cross-domain/cross-domain-view";
import { ExperimentalistView } from "@/components/experimentalist/experimentalist-view";
import { WriterView } from "@/components/writer/writer-view";
import { WebView } from "@/components/web/web-view";

// Two primary sections. RESEARCH holds the four agents (per-library work, with
// libraries as optional collections). DISCOVERY holds the corpus-wide research
// web and cross-domain crossover discovery. Default landing is DISCOVERY.
type Section = "research" | "discovery";
type ResearchView = "scribe" | "critic" | "experimentalist" | "writer";
type DiscoveryView = "web" | "cross-domain";

const RESEARCH_TABS: { id: ResearchView; name: string }[] = [
  { id: "scribe", name: "Scribe" },
  { id: "critic", name: "Critic" },
  { id: "experimentalist", name: "Experimentalist" },
  { id: "writer", name: "Writer" },
];
const DISCOVERY_TABS: { id: DiscoveryView; name: string }[] = [
  { id: "web", name: "Web" },
  { id: "cross-domain", name: "Cross-Domain" },
];

export default function Home() {
  const [section, setSection] = useState<Section>("discovery");
  const [research, setResearch] = useState<ResearchView>("scribe");
  const [discovery, setDiscovery] = useState<DiscoveryView>("web");

  return (
    <main className="mx-auto w-full max-w-5xl px-6 pb-32">
      <Header />

      {/* Primary section nav. */}
      <nav className="flex gap-x-8 border-b border-border">
        {(["discovery", "research"] as Section[]).map((s) => {
          const activeS = section === s;
          return (
            <button
              key={s}
              type="button"
              onClick={() => setSection(s)}
              className="group relative -mb-px pb-3 pt-1 text-left"
              aria-current={activeS ? "page" : undefined}
            >
              <span className={["text-sm font-semibold uppercase tracking-wide transition-colors", activeS ? "text-text-primary" : "text-text-secondary group-hover:text-text-primary"].join(" ")}>
                {s === "discovery" ? "Discovery" : "Research"}
              </span>
              {activeS && (
                <motion.span layoutId="primary-underline" className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-accent" transition={{ type: "spring", stiffness: 420, damping: 34 }} />
              )}
            </button>
          );
        })}
      </nav>

      {/* Secondary nav within the active section. */}
      <div className="mt-4 flex flex-wrap gap-2">
        {section === "research"
          ? RESEARCH_TABS.map((t) => (
              <SubTab key={t.id} name={t.name} active={research === t.id} onSelect={() => setResearch(t.id)} />
            ))
          : DISCOVERY_TABS.map((t) => (
              <SubTab key={t.id} name={t.name} active={discovery === t.id} onSelect={() => setDiscovery(t.id)} />
            ))}
      </div>

      <div className="mt-8">
        <AnimatePresence mode="wait">
          <motion.section
            key={`${section}:${section === "research" ? research : discovery}`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
          >
            {section === "research" ? (
              research === "scribe" ? <ScribeView /> : research === "critic" ? <CriticView /> : research === "experimentalist" ? <ExperimentalistView /> : <WriterView />
            ) : discovery === "web" ? (
              <WebView />
            ) : (
              <CrossDomainView />
            )}
          </motion.section>
        </AnimatePresence>
      </div>
    </main>
  );
}

function SubTab({ name, active, onSelect }: { name: string; active: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`rounded-full border px-3 py-1 text-[13px] transition-colors ${
        active ? "border-accent/50 bg-accent-dim text-accent" : "border-border text-text-secondary hover:border-accent/30 hover:text-accent"
      }`}
    >
      {name}
    </button>
  );
}
