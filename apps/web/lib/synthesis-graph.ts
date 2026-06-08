import type { RelationType, SynthesisRelation } from "@/lib/types";

export type PaperEdge = {
  // unordered paper pair (sorted ids) — paper-level edges are drawn once
  a: string;
  b: string;
  dominantType: RelationType;
  counts: { supports: number; contradicts: number; extends: number };
  relations: SynthesisRelation[]; // underlying claim-level relations
};

const KNOWN: RelationType[] = ["supports", "contradicts", "extends"];

function normalizeType(t: string): RelationType {
  return (KNOWN as string[]).includes(t) ? (t as RelationType) : "extends";
}

// Aggregate directed claim-level relations into undirected paper-level edges.
// Skips self-edges (a relation whose two claims share a paper).
export function aggregateEdges(relations: SynthesisRelation[]): PaperEdge[] {
  const byPair = new Map<string, PaperEdge>();
  for (const r of relations) {
    if (r.fromPaperId === r.toPaperId) continue;
    const [a, b] = [r.fromPaperId, r.toPaperId].sort();
    const key = `${a}|${b}`;
    let edge = byPair.get(key);
    if (!edge) {
      edge = {
        a,
        b,
        dominantType: "extends",
        counts: { supports: 0, contradicts: 0, extends: 0 },
        relations: [],
      };
      byPair.set(key, edge);
    }
    edge.counts[normalizeType(r.relationType)]++;
    edge.relations.push(r);
  }

  // Dominant type by SALIENCE, not frequency: contradictions are the most
  // informative output, so any pair containing one is shown as a contradiction
  // (a single extends should never bury a real conflict). Then supports, then
  // extends. The full per-type counts and underlying relations stay attached,
  // so the drill-down panel still surfaces every relation on the edge.
  for (const edge of byPair.values()) {
    edge.dominantType =
      edge.counts.contradicts > 0
        ? "contradicts"
        : edge.counts.supports > 0
          ? "supports"
          : "extends";
  }

  return [...byPair.values()];
}

// Reused warm tokens: green (supports), muted warm red (contradicts), warm gray
// (extends). No new bright colors.
export const RELATION_COLOR: Record<RelationType, string> = {
  supports: "var(--accent)",
  contradicts: "#b4493b",
  extends: "var(--text-muted)",
};

export const RELATION_LABEL: Record<RelationType, string> = {
  supports: "supports",
  contradicts: "contradicts",
  extends: "extends",
};

export function relationColor(t: string): string {
  return RELATION_COLOR[(t as RelationType)] ?? RELATION_COLOR.extends;
}

// What the user has focused in the graph; drives the detail panel.
export type GraphSelection =
  | { kind: "paper"; id: string }
  | { kind: "claim"; id: string; paperId: string }
  | { kind: "question"; id: string };
