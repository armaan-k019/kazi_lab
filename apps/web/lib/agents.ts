export type AgentId = "scribe" | "critic" | "experimentalist" | "writer";

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
    active: false,
  },
  { id: "writer", name: "Writer", role: "synthesis", active: false },
];
