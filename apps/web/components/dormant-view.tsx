import type { Agent } from "@/lib/agents";

// A quiet placeholder for agents that exist in the architecture but are not
// built yet. Not an error, not filler: a statement of where the system is.
export function DormantView({ agent }: { agent: Agent }) {
  return (
    <div className="flex min-h-[40vh] flex-col items-start justify-center gap-3">
      <div className="flex items-center gap-2">
        <span
          className="h-2 w-2 rounded-full border border-text-muted/70 bg-transparent"
          aria-hidden="true"
        />
        <span className="text-xs font-medium text-text-muted">
          {agent.role}, dormant
        </span>
      </div>
      <h2 className="text-lg font-medium text-text-secondary">
        The {agent.name} is not yet active.
      </h2>
      <p className="max-w-md text-[15px] leading-relaxed text-text-muted">
        {DESCRIPTIONS[agent.id]}
      </p>
    </div>
  );
}

const DESCRIPTIONS: Record<Agent["id"], string> = {
  scribe: "",
  critic:
    "The Critic will read the corpus and argue against it, surfacing counterarguments and weak claims. It comes online after the Scribe has accumulated enough to review.",
  experimentalist:
    "The Experimentalist will design and run experiments against the claims in the corpus, logging results back into the shared database.",
  writer:
    "The Writer will synthesize the corpus, critiques, and experiments into long-form output: paper sections, notes, and project pages.",
};
