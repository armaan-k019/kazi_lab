// Thin OpenAlex client (https://api.openalex.org), free, no API key. We use the
// polite pool by passing a mailto. Kept behind this module so another provider
// (e.g. Semantic Scholar) could be added later.
//
// Verified API shape (live): works are reachable by DOI at
// /works/doi:{doi} and arXiv works carry the DOI 10.48550/arXiv.{id}. Title
// search uses /works?filter=title.search:{q}. Fields used: id (URL), doi (URL),
// title/display_name, publication_year, cited_by_count,
// primary_location.source.display_name (venue), authorships[].author.{id,display_name}.

const BASE = "https://api.openalex.org";
const DEFAULT_MAILTO = "kazi-lab@example.com";
const USER_AGENT = "kazi-lab/0.1 (research; OpenAlex enrichment)";
const TIMEOUT_MS = 20_000;

export type OpenAlexCandidate = {
  openalexId: string; // "W..." (URL prefix stripped)
  doi: string | null; // "10...." (https://doi.org/ prefix stripped)
  title: string;
  year: number | null;
  citedByCount: number | null;
  venue: string | null;
  authorNames: string[];
  authorIds: string[]; // "A..." (URL prefix stripped)
};

type RawWork = {
  id?: string;
  doi?: string | null;
  title?: string | null;
  display_name?: string | null;
  publication_year?: number | null;
  cited_by_count?: number | null;
  primary_location?: { source?: { display_name?: string | null } | null } | null;
  authorships?: {
    author?: { id?: string | null; display_name?: string | null } | null;
  }[];
};

function mailto(): string {
  return process.env.OPENALEX_MAILTO || DEFAULT_MAILTO;
}

function stripPrefix(value: string | null | undefined, prefix: string): string | null {
  if (!value) return null;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function toCandidate(w: RawWork): OpenAlexCandidate {
  const authorships = w.authorships ?? [];
  return {
    openalexId: stripPrefix(w.id, "https://openalex.org/") ?? "",
    doi: stripPrefix(w.doi ?? null, "https://doi.org/"),
    title: (w.title ?? w.display_name ?? "").trim(),
    year: w.publication_year ?? null,
    citedByCount: w.cited_by_count ?? null,
    venue: w.primary_location?.source?.display_name ?? null,
    authorNames: authorships
      .map((a) => (a.author?.display_name ?? "").trim())
      .filter((n) => n.length > 0),
    authorIds: authorships
      .map((a) => stripPrefix(a.author?.id ?? null, "https://openalex.org/"))
      .filter((id): id is string => !!id),
  };
}

async function getJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`OpenAlex request failed: ${res.status} ${res.statusText}`);
    }
    return await res.json();
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`OpenAlex request timed out after ${TIMEOUT_MS / 1000}s.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// Look up a single work by DOI. Returns null if not found.
export async function getWorkByDoi(doi: string): Promise<OpenAlexCandidate | null> {
  const clean = doi.replace(/^https?:\/\/doi\.org\//i, "");
  const url = `${BASE}/works/doi:${encodeURIComponent(clean)}?mailto=${encodeURIComponent(mailto())}`;
  const json = (await getJson(url)) as RawWork | null;
  if (!json || !json.id) return null;
  return toCandidate(json);
}

// The arXiv preprint record in OpenAlex carries DOI 10.48550/arXiv.{id}.
export async function getWorkByArxivId(
  arxivId: string,
): Promise<OpenAlexCandidate | null> {
  return getWorkByDoi(`10.48550/arXiv.${arxivId}`);
}

// Search works by title. Returns up to `perPage` candidates.
export async function searchWorkByTitle(
  title: string,
  perPage = 25,
): Promise<OpenAlexCandidate[]> {
  const q = title.replace(/[^a-zA-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  if (!q) return [];
  const url =
    `${BASE}/works?filter=title.search:${encodeURIComponent(q)}` +
    `&per-page=${perPage}&mailto=${encodeURIComponent(mailto())}`;
  const json = (await getJson(url)) as { results?: RawWork[] } | null;
  return (json?.results ?? []).map(toCandidate);
}
