import { eq, isNotNull } from "drizzle-orm";
import { citations, db, paperExternal, papers } from "@kazi-lab/db";
import { fetchReferences, resolveSemanticScholar, semanticScholarKeyStatus } from "./semantic-scholar";

// Backfill the citations table from Semantic Scholar for the EXISTING corpus.
// For each paper, resolve it on Semantic Scholar and fetch its references (the
// papers it cites). Each reference becomes a citation row; if the referenced
// paper is in the corpus it is linked (cited_paper_id), otherwise the title and
// arXiv id are stored with a null link. The isInfluential flag is kept in
// context so the web build can weight influential citations higher. Idempotent
// per paper (clears prior rows for that citing paper first). Non-fatal per paper.

function normTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

export type BackfillResult = {
  keyStatus: "keyed" | "keyless";
  papersProcessed: number;
  papersResolved: number;
  edgesCreated: number;
  linkedToCorpus: number;
  skipped: { title: string; reason: string }[];
};

export async function backfillCitations(refLimit = 100): Promise<BackfillResult> {
  const corpus = await db.select({ id: papers.id, arxivId: papers.arxivId, title: papers.title }).from(papers);
  const ext = await db.select({ paperId: paperExternal.paperId, doi: paperExternal.doi }).from(paperExternal).where(isNotNull(paperExternal.doi));
  const doiByPaper = new Map(ext.map((e) => [e.paperId, (e.doi ?? "").toLowerCase()]));

  // Corpus lookup maps for conservative reference matching.
  const byArxiv = new Map<string, string>();
  const byDoi = new Map<string, string>();
  const byTitle = new Map<string, string>();
  for (const p of corpus) {
    if (p.arxivId) byArxiv.set(p.arxivId.toLowerCase(), p.id);
    const doi = doiByPaper.get(p.id);
    if (doi) byDoi.set(doi, p.id);
    if (p.title) byTitle.set(normTitle(p.title), p.id);
  }

  const result: BackfillResult = {
    keyStatus: semanticScholarKeyStatus(),
    papersProcessed: 0,
    papersResolved: 0,
    edgesCreated: 0,
    linkedToCorpus: 0,
    skipped: [],
  };

  for (const p of corpus) {
    result.papersProcessed++;
    const ss = await resolveSemanticScholar({ arxivId: p.arxivId, doi: doiByPaper.get(p.id) ?? null, title: p.title });
    if (!ss) {
      result.skipped.push({ title: p.title.slice(0, 70), reason: "not resolved on Semantic Scholar" });
      continue;
    }
    result.papersResolved++;
    const refs = await fetchReferences(ss.paperId, refLimit);
    if (refs.length === 0) continue;

    // Idempotent: clear this paper's existing citation rows, then insert fresh.
    await db.delete(citations).where(eq(citations.citingPaperId, p.id));
    const rows = refs
      .map((r) => {
        let cited: string | null = null;
        if (r.arxivId && byArxiv.has(r.arxivId.toLowerCase())) cited = byArxiv.get(r.arxivId.toLowerCase())!;
        else if (r.doi && byDoi.has(r.doi.toLowerCase())) cited = byDoi.get(r.doi.toLowerCase())!;
        else if (r.title && byTitle.has(normTitle(r.title))) cited = byTitle.get(normTitle(r.title))!;
        const title = (r.title || "(untitled reference)").slice(0, 300);
        if (cited === p.id) return null; // never self-cite
        return {
          citingPaperId: p.id,
          citedPaperId: cited,
          citedTitle: title,
          citedArxivId: r.arxivId,
          context: JSON.stringify({ source: "semantic_scholar", isInfluential: r.isInfluential, fieldsOfStudy: r.fieldsOfStudy }),
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
    if (rows.length) {
      await db.insert(citations).values(rows);
      result.edgesCreated += rows.length;
      result.linkedToCorpus += rows.filter((r) => r.citedPaperId !== null).length;
    }
  }
  return result;
}
