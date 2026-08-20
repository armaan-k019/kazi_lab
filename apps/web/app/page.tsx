"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Header } from "@/components/header";
import { LabProvider } from "@/components/shell/lab-context";
import { DiscoveryShell } from "@/components/discovery/discovery-shell";
import { ResearchShell } from "@/components/research/research-shell";

// Two primary sections, ONE shared shell implementation. DISCOVERY's primary
// region is the portal; RESEARCH's is the selected library's pipeline strip.
// Panels come from the shared registry, filtered per tab. The LabProvider
// sits above both so lab state (and selection) survives tab switches.
type Section = "research" | "discovery";

export default function Home() {
  const [section, setSection] = useState<Section>("discovery");

  return (
    <LabProvider>
      <main className="mx-auto w-full max-w-[1720px] px-4 pb-6">
        <Header compact />

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

        <div className="mt-3">
          <AnimatePresence mode="wait">
            <motion.section
              key={section}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
            >
              {section === "discovery" ? <DiscoveryShell /> : <ResearchShell />}
            </motion.section>
          </AnimatePresence>
        </div>
      </main>
    </LabProvider>
  );
}
