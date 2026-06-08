import { eq } from "drizzle-orm";
import { db, paperExternal, papers } from "@kazi-lab/db";
import { resolvePaperExternal, type ResolvablePaper } from "./resolve-external";

// Resolve a paper against OpenAlex, upsert its paper_external row, and (only for
// inferred-metadata papers with a confident match) improve the papers row with
// authoritative title/authors/year. Inferred = no arXiv id (PDF/HTML); arXiv
// metadata is authoritative already and never overwritten.
export async function enrichPaperExternal(args: {
  paperId: string;
  paper: ResolvablePaper;
}): Promise<{ matchStatus: string; improvedMetadata: boolean }> {
  const res = await resolvePaperExternal(args.paper);
  const scoreStr = res.matchScore != null ? res.matchScore.toFixed(3) : null;

  const values = {
    paperId: args.paperId,
    source: "openalex" as const,
    openalexId: res.openalexId,
    doi: res.doi,
    citedByCount: res.citedByCount,
    venue: res.venue,
    authoritativeTitle: res.authoritativeTitle,
    authoritativeYear: res.authoritativeYear,
    matchStatus: res.matchStatus,
    matchScore: scoreStr,
    authorOpenalexIds: res.authorOpenalexIds,
  };

  await db
    .insert(paperExternal)
    .values(values)
    .onConflictDoUpdate({
      target: [paperExternal.paperId, paperExternal.source],
      set: {
        openalexId: values.openalexId,
        doi: values.doi,
        citedByCount: values.citedByCount,
        venue: values.venue,
        authoritativeTitle: values.authoritativeTitle,
        authoritativeYear: values.authoritativeYear,
        matchStatus: values.matchStatus,
        matchScore: values.matchScore,
        authorOpenalexIds: values.authorOpenalexIds,
        updatedAt: new Date(),
      },
    });

  let improvedMetadata = false;
  const inferred = !args.paper.arxivId;
  if (inferred && res.matchStatus === "matched") {
    const set: {
      title?: string;
      authors?: string[];
      publishedAt?: Date;
    } = {};
    if (res.authoritativeTitle) set.title = res.authoritativeTitle;
    if (res.authorNames.length > 0) set.authors = res.authorNames;
    if (res.authoritativeYear) {
      set.publishedAt = new Date(Date.UTC(res.authoritativeYear, 0, 1));
    }
    if (Object.keys(set).length > 0) {
      await db.update(papers).set(set).where(eq(papers.id, args.paperId));
      improvedMetadata = true;
    }
  }

  return { matchStatus: res.matchStatus, improvedMetadata };
}
