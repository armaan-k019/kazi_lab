"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Header } from "@/components/header";
import { TabBar } from "@/components/tab-bar";
import { ScribeView } from "@/components/scribe/scribe-view";
import { CriticView } from "@/components/critic/critic-view";
import { CrossDomainView } from "@/components/cross-domain/cross-domain-view";
import { ExperimentalistView } from "@/components/experimentalist/experimentalist-view";
import { WriterView } from "@/components/writer/writer-view";
import { WebView } from "@/components/web/web-view";
import { DormantView } from "@/components/dormant-view";
import { AGENTS, type ViewId } from "@/lib/agents";

export default function Home() {
  // The research web is the primary substrate and the default landing view.
  const [active, setActive] = useState<ViewId>("web");
  const agent = AGENTS.find((a) => a.id === active);

  return (
    <main className="mx-auto w-full max-w-5xl px-6 pb-32">
      <Header />
      <TabBar active={active} onSelect={setActive} />

      <div className="mt-10">
        <AnimatePresence mode="wait">
          <motion.section
            key={active}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
          >
            {active === "web" ? (
              <WebView />
            ) : active === "scribe" ? (
              <ScribeView />
            ) : active === "critic" ? (
              <CriticView />
            ) : active === "cross-domain" ? (
              <CrossDomainView />
            ) : active === "experimentalist" ? (
              <ExperimentalistView />
            ) : active === "writer" ? (
              <WriterView />
            ) : agent ? (
              <DormantView agent={agent} />
            ) : null}
          </motion.section>
        </AnimatePresence>
      </div>
    </main>
  );
}
