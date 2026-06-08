import {
  getWorkByArxivId,
  searchWorkByTitle,
  type OpenAlexCandidate,
} from "./openalex";

// Matching thresholds (documented). A wrong match is worse than no match, so
// these are deliberately conservative: we require a strong title match AND real
// author overlap before accepting. Title-only matches (e.g. a Wikipedia page
// whose inferred authors are empty) never clear the bar and come back
// unmatched, which is the correct outcome for non-papers.
const TITLE_STRONG = 0.82; // token Jaccard for a confident title match
const TITLE_WEAK = 0.6; // minimum for an "ambiguous" flag
const AUTHOR_STRONG = 0.5; // fraction of our author surnames found in candidate
const SCORE_MATCH = 0.7;
const SCORE_AMBIGUOUS = 0.5;

export type ExternalResolution = {
  matchStatus: "matched" | "ambiguous" | "unmatched";
  matchScore: number | null;
  openalexId: string | null;
  doi: string | null;
  citedByCount: number | null;
  venue: string | null;
  authoritativeTitle: string | null;
  authoritativeYear: number | null;
  authorOpenalexIds: string[];
  authorNames: string[]; // authoritative author names (for improving metadata)
};

export type ResolvablePaper = {
  title: string;
  authors: string[];
  publishedAt: Date | null;
  arxivId: string | null;
};

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function surnames(names: string[]): string[] {
  return names
    .map((n) => n.trim().split(/\s+/).pop() ?? "")
    .map((s) => s.toLowerCase())
    .filter((s) => s.length > 1);
}

// Fraction of our author surnames that appear among the candidate's authors.
function authorOverlap(ourSurnames: string[], candNames: string[]): number {
  if (ourSurnames.length === 0) return 0; // cannot verify without authors
  const hay = candNames.join(" ").toLowerCase();
  const hits = ourSurnames.filter((s) => hay.includes(s)).length;
  return hits / ourSurnames.length;
}

function yearScore(ourYear: number | null, candYear: number | null): number {
  if (ourYear == null || candYear == null) return 0;
  const d = Math.abs(ourYear - candYear);
  if (d <= 1) return 1;
  if (d <= 3) return 0.5;
  return 0;
}

const UNMATCHED: ExternalResolution = {
  matchStatus: "unmatched",
  matchScore: null,
  openalexId: null,
  doi: null,
  citedByCount: null,
  venue: null,
  authoritativeTitle: null,
  authoritativeYear: null,
  authorOpenalexIds: [],
  authorNames: [],
};

function toResolution(
  c: OpenAlexCandidate,
  status: "matched" | "ambiguous",
  score: number,
): ExternalResolution {
  return {
    matchStatus: status,
    matchScore: score,
    openalexId: c.openalexId || null,
    doi: c.doi,
    citedByCount: c.citedByCount,
    venue: c.venue,
    authoritativeTitle: c.title || null,
    authoritativeYear: c.year,
    authorOpenalexIds: c.authorIds,
    authorNames: c.authorNames,
  };
}

// Resolve a paper to its OpenAlex identity, conservatively. Non-papers and weak
// matches come back unmatched/ambiguous rather than a confident wrong match.
export async function resolvePaperExternal(
  paper: ResolvablePaper,
): Promise<ExternalResolution> {
  const ourTitle = tokens(paper.title);
  const ourSurnames = surnames(paper.authors);
  const ourYear = paper.publishedAt
    ? paper.publishedAt.getUTCFullYear()
    : null;

  // Gather candidates: the exact arXiv record (if any) plus title-search hits.
  const candidates: OpenAlexCandidate[] = [];
  if (paper.arxivId) {
    try {
      const anchor = await getWorkByArxivId(paper.arxivId);
      if (anchor) candidates.push(anchor);
    } catch {
      // ignore; fall back to title search
    }
  }
  for (const c of await searchWorkByTitle(paper.title)) candidates.push(c);

  // Dedupe by OpenAlex id.
  const seen = new Set<string>();
  const unique = candidates.filter((c) => {
    if (!c.openalexId || seen.has(c.openalexId)) return false;
    seen.add(c.openalexId);
    return true;
  });
  if (unique.length === 0) return UNMATCHED;

  const scored = unique.map((c) => {
    const ts = jaccard(ourTitle, tokens(c.title));
    const ao = authorOverlap(ourSurnames, c.authorNames);
    const ys = yearScore(ourYear, c.year);
    const score = 0.6 * ts + 0.3 * ao + 0.1 * ys;
    return { c, ts, ao, score };
  });

  // Confident matches: strong title + real author overlap. Among those, prefer
  // the most-cited record (the canonical published version over the preprint).
  const verified = scored.filter(
    (s) => s.ts >= TITLE_STRONG && s.ao >= AUTHOR_STRONG && s.score >= SCORE_MATCH,
  );
  if (verified.length > 0) {
    const pick = verified.reduce((best, s) =>
      (s.c.citedByCount ?? 0) > (best.c.citedByCount ?? 0) ? s : best,
    );
    return toResolution(pick.c, "matched", pick.score);
  }

  // Plausible but unverified: flag ambiguous (requires some author evidence).
  const ambiguous = scored
    .filter((s) => s.ts >= TITLE_WEAK && s.ao > 0 && s.score >= SCORE_AMBIGUOUS)
    .sort((a, b) => b.score - a.score);
  if (ambiguous.length > 0) {
    return toResolution(ambiguous[0].c, "ambiguous", ambiguous[0].score);
  }

  return UNMATCHED;
}
