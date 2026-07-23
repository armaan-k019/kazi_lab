export type AgentId = "scribe" | "critic" | "experimentalist" | "writer";

// Top-level views. Agents are per-library; "web" (the corpus-wide research web,
// the primary substrate and default landing view) and "cross-domain" are
// lab-level views, so they live in the nav but are not agents.
export type ViewId = AgentId | "cross-domain" | "web";

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
