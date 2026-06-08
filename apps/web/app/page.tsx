"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Header } from "@/components/header";
import { TabBar } from "@/components/tab-bar";
import { ScribeView } from "@/components/scribe/scribe-view";
import { DormantView } from "@/components/dormant-view";
import { AGENTS, type AgentId } from "@/lib/agents";

export default function Home() {
  const [active, setActive] = useState<AgentId>("scribe");
  const agent = AGENTS.find((a) => a.id === active)!;

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
            {active === "scribe" ? (
              <ScribeView />
            ) : (
              <DormantView agent={agent} />
            )}
          </motion.section>
        </AnimatePresence>
      </div>
    </main>
  );
}
