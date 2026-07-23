import { fetchWithTimeout } from "./http";

// Crossref client (https://api.crossref.org). DOI metadata + references for
// non-arXiv papers where Semantic Scholar misses. Uses the polite pool via
// CROSSREF_MAILTO when set. Keyless, non-fatal: returns null on any failure.

const BASE = "https://api.crossref.org";
const TIMEOUT_MS = 20_000;

function politeParam(): string {
  const mailto = process.env.CROSSREF_MAILTO;
  return mailto ? `?mailto=${encodeURIComponent(mailto)}` : "";
}

export type CrossrefWork = {
  doi: string;
  title: string | null;
  references: { doi: string | null; title: string | null }[];
};

type RawItem = {
  DOI?: string;
  title?: string[];
  reference?: { DOI?: string; "article-title"?: string; "unstructured"?: string }[];
};

// Fetch DOI metadata + references. Returns null on failure (logged).
export async function crossrefWork(doi: string): Promise<CrossrefWork | null> {
  const clean = doi.replace(/^https?:\/\/(dx\.)?doi\.org\//, "").trim();
  if (!clean) return null;
  try {
    const res = await fetchWithTimeout(`${BASE}/works/${encodeURIComponent(clean)}${politeParam()}`, {}, TIMEOUT_MS);
    if (!res.ok) {
      if (res.status !== 404) console.warn(`Crossref ${res.status} for ${clean}`);
      return null;
    }
    const json = (await res.json()) as { message?: RawItem };
    const m = json.message;
    if (!m) return null;
    return {
      doi: clean,
      title: m.title?.[0]?.trim() ?? null,
      references: (m.reference ?? []).map((r) => ({
        doi: r.DOI ?? null,
        title: (r["article-title"] ?? r["unstructured"] ?? "").trim() || null,
      })),
    };
  } catch (e) {
    console.warn(`Crossref fetch failed for ${clean}: ${(e as Error).message}`);
    return null;
  }
}
