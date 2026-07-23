import { fetchWithTimeout } from "./http";

// Semantic Scholar Graph API client (https://api.semanticscholar.org/graph/v1).
// Keyless-capable: an api key (SEMANTIC_SCHOLAR_API_KEY) only raises the rate
// limit. Every call is non-fatal: on failure it logs and returns null/[], never
// throwing into the caller, and never fabricating data. Conservative matching
// (prefer unmatched over a wrong match), mirroring the OpenAlex client.

const BASE = "https://api.semanticscholar.org/graph/v1";
const TIMEOUT_MS = 25_000;
// Keyless is rate-limited; space calls politely and back off on 429.
const SPACING_MS = 1200;
const MAX_RETRIES = 3;

let lastCallAt = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function headers(): Record<string, string> {
  const key = process.env.SEMANTIC_SCHOLAR_API_KEY;
  return key ? { "x-api-key": key } : {};
}
export function semanticScholarKeyStatus(): "keyed" | "keyless" {
  return process.env.SEMANTIC_SCHOLAR_API_KEY ? "keyed" : "keyless";
}

// Polite, backing-off GET. Returns parsed JSON or null (logged) on any failure.
async function ssFetch<T>(path: string): Promise<T | null> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const wait = Math.max(0, lastCallAt + SPACING_MS - Date.now());
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    try {
      const res = await fetchWithTimeout(`${BASE}${path}`, { headers: headers() }, TIMEOUT_MS);
      if (res.status === 429 || res.status === 503) {
        await sleep(SPACING_MS * (attempt + 2));
        continue;
      }
      if (res.status === 404) return null;
      if (!res.ok) {
        console.warn(`Semantic Scholar ${res.status} for ${path}`);
        return null;
      }
      return (await res.json()) as T;
    } catch (e) {
      console.warn(`Semantic Scholar fetch failed for ${path}: ${(e as Error).message}`);
      if (attempt === MAX_RETRIES) return null;
      await sleep(SPACING_MS * (attempt + 2));
    }
  }
  return null;
}

export type SSPaper = {
  paperId: string;
  title: string;
  fieldsOfStudy: string[];
  arxivId: string | null;
  doi: string | null;
  citationCount: number | null;
};
export type SSNeighbor = {
  paperId: string | null;
  title: string;
  arxivId: string | null;
  doi: string | null;
  fieldsOfStudy: string[];
  citationCount: number | null;
  isInfluential: boolean;
};

type RawExternalIds = { ArXiv?: string | null; DOI?: string | null };
type RawPaper = {
  paperId?: string;
  title?: string | null;
  fieldsOfStudy?: (string | null)[] | null;
  s2FieldsOfStudy?: { category?: string }[] | null;
  externalIds?: RawExternalIds | null;
  citationCount?: number | null;
};

const PAPER_FIELDS = "paperId,title,fieldsOfStudy,s2FieldsOfStudy,externalIds,citationCount";

function fields(p: RawPaper): string[] {
  const a = (p.fieldsOfStudy ?? []).filter((x): x is string => !!x);
  const b = (p.s2FieldsOfStudy ?? []).map((x) => x.category).filter((x): x is string => !!x);
  return [...new Set([...a, ...b])];
}
function toPaper(p: RawPaper): SSPaper | null {
  if (!p.paperId) return null;
  return {
    paperId: p.paperId,
    title: (p.title ?? "").trim(),
    fieldsOfStudy: fields(p),
    arxivId: p.externalIds?.ArXiv ?? null,
    doi: p.externalIds?.DOI ?? null,
    citationCount: p.citationCount ?? null,
  };
}
function toNeighbor(p: RawPaper, isInfluential: boolean): SSNeighbor {
  return {
    paperId: p.paperId ?? null,
    title: (p.title ?? "").trim(),
    arxivId: p.externalIds?.ArXiv ?? null,
    doi: p.externalIds?.DOI ?? null,
    fieldsOfStudy: fields(p),
    citationCount: p.citationCount ?? null,
    isInfluential,
  };
}

// Resolve a paper by arXiv id, DOI, or (last resort) title search. Conservative:
// title search returns the top hit only when it is unambiguous enough; otherwise
// null (prefer unmatched over wrong).
export async function resolveSemanticScholar(input: { arxivId?: string | null; doi?: string | null; title?: string | null }): Promise<SSPaper | null> {
  if (input.arxivId) {
    const p = await ssFetch<RawPaper>(`/paper/ARXIV:${encodeURIComponent(input.arxivId)}?fields=${PAPER_FIELDS}`);
    if (p) return toPaper(p);
  }
  if (input.doi) {
    const p = await ssFetch<RawPaper>(`/paper/DOI:${encodeURIComponent(input.doi)}?fields=${PAPER_FIELDS}`);
    if (p) return toPaper(p);
  }
  if (input.title && input.title.trim().length > 8) {
    const q = encodeURIComponent(input.title.trim());
    const r = await ssFetch<{ data?: RawPaper[] }>(`/paper/search?query=${q}&limit=1&fields=${PAPER_FIELDS}`);
    const top = r?.data?.[0];
    if (top && (top.title ?? "").trim().length > 0) return toPaper(top);
  }
  return null;
}

type RawRefEdge = { isInfluential?: boolean; citedPaper?: RawPaper };
type RawCiteEdge = { isInfluential?: boolean; citingPaper?: RawPaper };

// Papers this paper CITES (its references).
export async function fetchReferences(paperId: string, limit = 100): Promise<SSNeighbor[]> {
  const r = await ssFetch<{ data?: RawRefEdge[] }>(`/paper/${paperId}/references?limit=${limit}&fields=isInfluential,${PAPER_FIELDS}`);
  return (r?.data ?? []).filter((e) => e.citedPaper).map((e) => toNeighbor(e.citedPaper!, !!e.isInfluential));
}
// Papers that CITE this paper.
export async function fetchCitations(paperId: string, limit = 100): Promise<SSNeighbor[]> {
  const r = await ssFetch<{ data?: RawCiteEdge[] }>(`/paper/${paperId}/citations?limit=${limit}&fields=isInfluential,${PAPER_FIELDS}`);
  return (r?.data ?? []).filter((e) => e.citingPaper).map((e) => toNeighbor(e.citingPaper!, !!e.isInfluential));
}
