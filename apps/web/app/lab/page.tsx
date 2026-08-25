"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { Header } from "@/components/header";
import { LabProvider, useLab } from "@/components/shell/lab-context";
import { DiscoveryShell } from "@/components/discovery/discovery-shell";
import { ResearchShell } from "@/components/research/research-shell";
import { DevTuningPanel, EnvironmentField } from "@/components/shell/environment-field";
import { MOTION } from "@/lib/design-tokens";

// The dark spatial shell: ONE corpus-field canvas is the environment behind
// both tabs (focused and interactive on Discovery, ambient on Research), the
// content floats above it, and empty regions pass pointer events through to
// the field. Interactive content re-enables its own pointer events.
type Section = "research" | "discovery";

export default function LabPage() {
  return (
    <Suspense fallback={null}>
      <LabHome />
    </Suspense>
  );
}

// Deep links from the narrative: /lab?view=research&library=<id> lands on
// the Research tab with that library preselected.
function DeepLink() {
  const params = useSearchParams();
  const { setSelectedLibraryId } = useLab();
  useEffect(() => {
    const lib = params.get("library");
    if (lib) setSelectedLibraryId(lib);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);
  return null;
}

function LabHome() {
  const params = useSearchParams();
  const [section, setSection] = useState<Section>(params.get("view") === "research" ? "research" : "discovery");

  return (
    <LabProvider>
      <DeepLink />
      <EnvironmentField focused={section === "discovery"} calmed={section === "research"} />
      <DevTuningPanel />
      <main className="pointer-events-none relative z-10 mx-auto w-full max-w-[1720px] px-5 pb-6 lg:px-8">
        {/* The lab name sits directly on the environment: pure editorial type. */}
        <div className="pointer-events-auto inline-block">
          <Header compact />
        </div>

        {/* Primary section nav: 18px display type, marked by a green rule. */}
        <nav className="pointer-events-auto flex gap-x-10 border-b border-hairline">
          {(["discovery", "research"] as Section[]).map((s) => {
            const activeS = section === s;
            return (
              <button
                key={s}
                type="button"
                onClick={() => setSection(s)}
                className="group relative -mb-px pb-2.5 pt-1 text-left"
                aria-current={activeS ? "page" : undefined}
              >
                <span className={`font-display text-lead transition-colors duration-(--motion-disclose) ${activeS ? "text-ink" : "text-ink-500 group-hover:text-ink-700"}`}>
                  {s === "discovery" ? "Discovery" : "Research"}
                </span>
                {activeS && (
                  <motion.span
                    layoutId="primary-underline"
                    className="absolute inset-x-0 bottom-0 h-[2px] bg-green"
                    transition={{ duration: MOTION.panelMs / 1000, ease: "easeInOut" }}
                  />
                )}
              </button>
            );
          })}
          <Link
            href="/"
            className="ml-auto self-center rounded-full border border-hairline px-3 py-1 text-ui text-ink-500 transition-colors duration-(--motion-disclose) hover:border-green/40 hover:text-green-deep"
          >
            the story
          </Link>
        </nav>

        <div className="mt-4">
          <AnimatePresence mode="wait">
            <motion.section
              key={section}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: MOTION.panelMs / 1000, ease: [0.4, 0, 0.2, 1] }}
            >
              {section === "discovery" ? <DiscoveryShell /> : <ResearchShell />}
            </motion.section>
          </AnimatePresence>
        </div>
      </main>
    </LabProvider>
  );
}
