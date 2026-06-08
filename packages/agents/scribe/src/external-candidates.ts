import { and, eq, inArray } from "drizzle-orm";
import { db, paperExternal, paperLibraries } from "@kazi-lab/db";
import type { OpenAlexWork } from "./openalex";

// A browsable discovery suggestion. It only becomes corpus data when the user
// ingests it. inCorpus/inThisLibrary are resolved against stored OpenAlex ids.
export type DiscoveryCandidate = {
  openalexId: string;
  title: string;
  year: number | null;
  citedByCount: number | null;
  doi: string | null;
  ingestableUrl: string | null;
  inThisLibrary: boolean;
  inCorpus: boolean;
};

// Best fetchable URL for the existing ingest pipeline: prefer arXiv abs, then
// open-access full text, then a pdf, then the DOI landing page.
function ingestableUrl(w: OpenAlexWork): string | null {
  if (w.arxivAbsUrl) return w.arxivAbsUrl;
  if (w.oaUrl) return w.oaUrl;
  if (w.pdfUrl) return w.pdfUrl;
  if (w.doi) return `https://doi.org/${w.doi}`;
  return null;
}

// Shape a batch of works into candidates, resolving in-corpus / in-library
// flags with a single query each (matched by exact OpenAlex id).
export async function shapeCandidates(
  works: OpenAlexWork[],
  activeLibraryId: string,
): Promise<DiscoveryCandidate[]> {
  const ids = works.map((w) => w.openalexId).filter((id) => id.length > 0);

  const corpusByOpenalex = new Map<string, string>(); // openalexId -> paperId
  if (ids.length > 0) {
    const rows = await db
      .select({
        openalexId: paperExternal.openalexId,
        paperId: paperExternal.paperId,
      })
      .from(paperExternal)
      .where(
        and(
          eq(paperExternal.source, "openalex"),
          inArray(paperExternal.openalexId, ids),
        ),
      );
    for (const r of rows) if (r.openalexId) corpusByOpenalex.set(r.openalexId, r.paperId);
  }

  const corpusPaperIds = [...new Set(corpusByOpenalex.values())];
  const inLibrary = new Set<string>();
  if (corpusPaperIds.length > 0) {
    const links = await db
      .select({ paperId: paperLibraries.paperId })
      .from(paperLibraries)
      .where(
        and(
          eq(paperLibraries.libraryId, activeLibraryId),
          inArray(paperLibraries.paperId, corpusPaperIds),
        ),
      );
    for (const l of links) inLibrary.add(l.paperId);
  }

  return works.map((w) => {
    const paperId = corpusByOpenalex.get(w.openalexId);
    return {
      openalexId: w.openalexId,
      title: w.title,
      year: w.year,
      citedByCount: w.citedByCount,
      doi: w.doi,
      ingestableUrl: ingestableUrl(w),
      inCorpus: !!paperId,
      inThisLibrary: !!paperId && inLibrary.has(paperId),
    };
  });
}
