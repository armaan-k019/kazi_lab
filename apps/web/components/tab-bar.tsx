"use client";

import { motion } from "framer-motion";
import { AGENTS, type AgentId } from "@/lib/agents";

type Props = {
  active: AgentId;
  onSelect: (id: AgentId) => void;
};

export function TabBar({ active, onSelect }: Props) {
  return (
    <nav className="flex flex-wrap gap-x-8 gap-y-3 border-b border-border">
      {AGENTS.map((agent) => {
        const isActive = agent.id === active;
        const clickable = agent.active;

        return (
          <button
            key={agent.id}
            type="button"
            disabled={!clickable}
            onClick={() => clickable && onSelect(agent.id)}
            className={[
              "group relative -mb-px flex flex-col items-start pb-3 pt-1 text-left transition-opacity",
              clickable ? "cursor-pointer" : "cursor-default opacity-55",
            ].join(" ")}
            aria-current={isActive ? "page" : undefined}
          >
            <span className="flex items-center gap-2">
              <StatusDot live={agent.active} />
              <span
                className={[
                  "text-sm font-medium transition-colors",
                  isActive
                    ? "text-text-primary"
                    : clickable
                      ? "text-text-secondary group-hover:text-text-primary"
                      : "text-text-secondary",
                ].join(" ")}
              >
                {agent.name}
              </span>
            </span>
            <span className="mt-1 pl-[18px] text-[12px] text-text-muted">
              {agent.active ? agent.role : `${agent.role}, dormant`}
            </span>

            {isActive && (
              <motion.span
                layoutId="tab-underline"
                className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-accent"
                transition={{ type: "spring", stiffness: 420, damping: 34 }}
              />
            )}
          </button>
        );
      })}
    </nav>
  );
}

function StatusDot({ live }: { live: boolean }) {
  if (!live) {
    // Dormant: an unfilled outline dot.
    return (
      <span
        className="h-2 w-2 rounded-full border border-text-muted/70 bg-transparent"
        aria-hidden="true"
      />
    );
  }
  // Live: a calm, solid green dot. No glow, no ping.
  return (
    <span className="h-2 w-2 rounded-full bg-accent" aria-hidden="true" />
  );
}
