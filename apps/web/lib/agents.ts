export type AgentId = "scribe" | "critic" | "experimentalist" | "writer";

// Top-level views. Agents are per-library; "cross-domain" is a lab-level view
// that reads across projects, so it lives in the nav but is not an agent.
export type ViewId = AgentId | "cross-domain";

export type Agent = {
  id: AgentId;
  name: string;
  role: string;
  active: boolean;
};

// One live agent, three dormant. The contrast is intentional: the system is
// real but early.
export const AGENTS: Agent[] = [
  { id: "scribe", name: "Scribe", role: "knowledge", active: true },
  { id: "critic", name: "Critic", role: "review", active: true },
  {
    id: "experimentalist",
    name: "Experimentalist",
    role: "experiments",
    active: true,
  },
  { id: "writer", name: "Writer", role: "synthesis", active: true },
];
