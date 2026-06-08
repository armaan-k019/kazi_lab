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

// ---------------------------------------------------------------------------
// Discovery: richer work records for the citation-context and author-works
// features. These carry the fields needed to shape ingestable candidates
// (references, citing works, best fetchable URL).
// ---------------------------------------------------------------------------

export type OpenAlexWork = {
  openalexId: string; // "W..."
  title: string;
  year: number | null;
  citedByCount: number | null;
  doi: string | null; // "10...."
  arxivAbsUrl: string | null; // https://arxiv.org/abs/{id} if this is an arXiv work
  oaUrl: string | null; // open access full-text URL
  pdfUrl: string | null; // primary location pdf
  landingUrl: string | null; // primary location landing page
  referencedWorkIds: string[]; // "W..." ids this work cites
  authors: { id: string; name: string }[]; // only authors with an OpenAlex id
};

type RawWorkFull = RawWork & {
  open_access?: { oa_url?: string | null } | null;
  primary_location?: {
    source?: { display_name?: string | null } | null;
    pdf_url?: string | null;
    landing_page_url?: string | null;
  } | null;
  locations?: { landing_page_url?: string | null }[] | null;
  referenced_works?: string[] | null;
};

function arxivAbsFrom(w: RawWorkFull): string | null {
  const doi = (w.doi ?? "").toLowerCase();
  const m = doi.match(/10\.48550\/arxiv\.([^/\s]+)/);
  if (m) return `https://arxiv.org/abs/${m[1]}`;
  for (const loc of w.locations ?? []) {
    const lp = loc.landing_page_url ?? "";
    const lm = lp.match(/arxiv\.org\/abs\/([^?#\s]+)/i);
    if (lm) return `https://arxiv.org/abs/${lm[1]}`;
  }
  return null;
}

function mapWork(w: RawWorkFull): OpenAlexWork {
  return {
    openalexId: stripPrefix(w.id, "https://openalex.org/") ?? "",
    title: (w.title ?? w.display_name ?? "").trim(),
    year: w.publication_year ?? null,
    citedByCount: w.cited_by_count ?? null,
    doi: stripPrefix(w.doi ?? null, "https://doi.org/"),
    arxivAbsUrl: arxivAbsFrom(w),
    oaUrl: w.open_access?.oa_url ?? null,
    pdfUrl: w.primary_location?.pdf_url ?? null,
    landingUrl: w.primary_location?.landing_page_url ?? null,
    referencedWorkIds: (w.referenced_works ?? []).map(
      (u) => stripPrefix(u, "https://openalex.org/") ?? "",
    ),
    authors: (w.authorships ?? [])
      .map((a) => ({
        id: stripPrefix(a.author?.id ?? null, "https://openalex.org/") ?? "",
        name: (a.author?.display_name ?? "").trim(),
      }))
      .filter((a) => a.id.length > 0 && a.name.length > 0),
  };
}

// Full work record by OpenAlex id (includes referenced_works, authorships).
export async function getWork(openalexId: string): Promise<OpenAlexWork | null> {
  const id = stripPrefix(openalexId, "https://openalex.org/") ?? openalexId;
  const url = `${BASE}/works/${encodeURIComponent(id)}?mailto=${encodeURIComponent(mailto())}`;
  const json = (await getJson(url)) as RawWorkFull | null;
  if (!json || !json.id) return null;
  return mapWork(json);
}

// Batch-fetch metadata for many works. OpenAlex allows up to 50 ids per OR
// filter, so we chunk. Order is not guaranteed; callers sort as needed.
export async function getWorksByIds(ids: string[]): Promise<OpenAlexWork[]> {
  const bare = ids
    .map((i) => stripPrefix(i, "https://openalex.org/") ?? i)
    .filter((i) => i.length > 0);
  const out: OpenAlexWork[] = [];
  for (let i = 0; i < bare.length; i += 50) {
    const chunk = bare.slice(i, i + 50);
    const url =
      `${BASE}/works?filter=openalex_id:${chunk.join("|")}` +
      `&per-page=${chunk.length}&mailto=${encodeURIComponent(mailto())}`;
    const json = (await getJson(url)) as { results?: RawWorkFull[] } | null;
    for (const w of json?.results ?? []) out.push(mapWork(w));
  }
  return out;
}

// Works that cite the given work, most influential first.
export async function getCitingWorks(
  openalexId: string,
  limit = 12,
): Promise<OpenAlexWork[]> {
  const id = stripPrefix(openalexId, "https://openalex.org/") ?? openalexId;
  const url =
    `${BASE}/works?filter=cites:${id}&sort=cited_by_count:desc` +
    `&per-page=${limit}&mailto=${encodeURIComponent(mailto())}`;
  const json = (await getJson(url)) as { results?: RawWorkFull[] } | null;
  return (json?.results ?? []).map(mapWork);
}

// Full-text relevance search, optionally restricted to recent work. Returns
// the richer work shape so results can be shaped into ingestable candidates.
export async function searchWorks(
  query: string,
  opts: { fromDate?: string; perPage?: number } = {},
): Promise<OpenAlexWork[]> {
  const q = query.trim();
  if (!q) return [];
  const perPage = opts.perPage ?? 12;
  let url =
    `${BASE}/works?search=${encodeURIComponent(q)}` +
    `&per-page=${perPage}&mailto=${encodeURIComponent(mailto())}`;
  if (opts.fromDate) {
    url += `&filter=from_publication_date:${opts.fromDate}`;
  }
  const json = (await getJson(url)) as { results?: RawWorkFull[] } | null;
  return (json?.results ?? []).map(mapWork);
}

// An author's works, most cited first.
export async function getAuthorWorks(
  authorId: string,
  limit = 15,
): Promise<OpenAlexWork[]> {
  const id = stripPrefix(authorId, "https://openalex.org/") ?? authorId;
  const url =
    `${BASE}/works?filter=author.id:${id}&sort=cited_by_count:desc` +
    `&per-page=${limit}&mailto=${encodeURIComponent(mailto())}`;
  const json = (await getJson(url)) as { results?: RawWorkFull[] } | null;
  return (json?.results ?? []).map(mapWork);
}
