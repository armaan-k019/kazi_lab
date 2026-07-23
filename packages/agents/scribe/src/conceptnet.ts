import { eq } from "drizzle-orm";
import { conceptnetCache, db } from "@kazi-lab/db";
import { fetchWithTimeout } from "./http";

// ConceptNet client (https://api.conceptnet.io). Used ONLY in the discovery layer
// to test whether a proposed cross-domain analogy has a grounded semantic path (a
// real relation chain) versus none. A proposal with no ConceptNet grounding is
// NOT auto-rejected; it is marked lower confidence and the absence is recorded.
// Keyless, cached in conceptnet_cache, non-fatal on failure.

const TIMEOUT_MS = 15_000;
const EDGE_LIMIT = 60;

function base(): string {
  return process.env.CONCEPTNET_BASE_URL || "https://api.conceptnet.io";
}
// ConceptNet term slugs are lowercase with underscores for spaces.
export function conceptnetSlug(term: string): string {
  return term.toLowerCase().trim().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, "_").replace(/^_+|_+$/g, "");
}

export type ConceptnetRelated = { related: { term: string; rel: string; weight: number }[] };

type RawEdge = {
  rel?: { label?: string };
  start?: { label?: string; language?: string; term?: string };
  end?: { label?: string; language?: string; term?: string };
  weight?: number;
};

// Fetch (and cache) the related concepts for one term. Returns null on failure.
export async function conceptnetRelated(term: string): Promise<ConceptnetRelated | null> {
  const slug = conceptnetSlug(term);
  if (!slug) return null;
  const [cached] = await db.select().from(conceptnetCache).where(eq(conceptnetCache.term, slug)).limit(1);
  if (cached) return cached.payload as ConceptnetRelated;
  try {
    const res = await fetchWithTimeout(`${base()}/c/en/${encodeURIComponent(slug)}?limit=${EDGE_LIMIT}`, {}, TIMEOUT_MS);
    if (!res.ok) {
      console.warn(`ConceptNet ${res.status} for ${slug}`);
      return null;
    }
    const json = (await res.json()) as { edges?: RawEdge[] };
    const related: ConceptnetRelated["related"] = [];
    for (const e of json.edges ?? []) {
      // Take the node on the OTHER side of this term, English only.
      for (const node of [e.start, e.end]) {
        if (!node?.label) continue;
        if (node.language && node.language !== "en") continue;
        const other = conceptnetSlug(node.label);
        if (other && other !== slug) related.push({ term: other, rel: e.rel?.label ?? "Related", weight: e.weight ?? 1 });
      }
    }
    const payload: ConceptnetRelated = { related };
    await db.insert(conceptnetCache).values({ term: slug, payload }).onConflictDoNothing();
    return payload;
  } catch (e) {
    console.warn(`ConceptNet fetch failed for ${slug}: ${(e as Error).message}`);
    return null;
  }
}

export type AnalogyGrounding = {
  grounded: boolean;
  kind: "direct" | "shared_neighbor" | "none" | "unavailable";
  path: string[];
  note: string;
};

// Test whether concepts A and C have a grounded relation path in ConceptNet: a
// direct edge, or a shared 1-hop neighbor. Absence is recorded, not fatal.
export async function groundAnalogy(termA: string, termC: string): Promise<AnalogyGrounding> {
  const a = await conceptnetRelated(termA);
  const c = await conceptnetRelated(termC);
  if (!a || !c) {
    return { grounded: false, kind: "unavailable", path: [], note: "ConceptNet lookup unavailable; grounding not tested." };
  }
  const slugC = conceptnetSlug(termC);
  const slugA = conceptnetSlug(termA);
  const direct = a.related.find((r) => r.term === slugC) ?? c.related.find((r) => r.term === slugA);
  if (direct) {
    return { grounded: true, kind: "direct", path: [slugA, direct.rel, slugC], note: `direct ConceptNet relation (${direct.rel})` };
  }
  const aTerms = new Set(a.related.map((r) => r.term));
  const shared = c.related.map((r) => r.term).filter((t) => aTerms.has(t));
  if (shared.length > 0) {
    return { grounded: true, kind: "shared_neighbor", path: [slugA, shared[0], slugC], note: `shared ConceptNet neighbor "${shared[0]}"` };
  }
  return { grounded: false, kind: "none", path: [], note: "no ConceptNet relation path found between the two sides" };
}
