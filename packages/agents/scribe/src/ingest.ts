import { eq } from "drizzle-orm";
import {
  authors,
  claims,
  db,
  extractions,
  paperAuthors,
  papers,
} from "@kazi-lab/db";
import { fetchSource } from "./fetch-source";
import { extractPaperFields } from "./extractor";

export async function ingestPaper(
  url: string,
): Promise<{ paperId: string; claimsInserted: number; alreadyIngested: boolean }> {
  console.log(`Fetching source: ${url}`);
  const paper = await fetchSource(url);
  console.log(`Fetched ${paper.sourceType} source: "${paper.title || "(untitled)"}"`);

  // Dedupe before the (costly) extraction call. arXiv keys on arxiv_id; other
  // sources key on the canonical URL.
  const existing = paper.arxivId
    ? await db
        .select({ id: papers.id })
        .from(papers)
        .where(eq(papers.arxivId, paper.arxivId))
        .limit(1)
    : await db
        .select({ id: papers.id })
        .from(papers)
        .where(eq(papers.url, paper.url))
        .limit(1);
  if (existing.length > 0) {
    console.log(`Already ingested: ${existing[0].id}. Skipping.`);
    return { paperId: existing[0].id, claimsInserted: 0, alreadyIngested: true };
  }

  console.log("Extracting with Claude...");
  const extraction = await extractPaperFields(paper);
  console.log(`Extracted ${extraction.claims.length} claims.`);

  // For inferred sources, prefer Claude's inferred metadata over the fetch-time
  // hints. For arXiv, the API metadata on `paper` is authoritative.
  const meta = extraction.inferredMetadata;
  const finalTitle = (meta?.title || paper.title || "(untitled)").trim();
  const finalAuthors = meta ? meta.authors : paper.authors;
  const finalPublishedAt = meta ? meta.publishedAt : paper.publishedAt;

  console.log("Writing to database...");
  const result = await db.transaction(async (tx) => {
    const [insertedPaper] = await tx
      .insert(papers)
      .values({
        arxivId: paper.arxivId,
        title: finalTitle,
        authors: finalAuthors,
        abstract: paper.abstract,
        publishedAt: finalPublishedAt,
        url: paper.url,
        pdfUrl: paper.pdfUrl,
        rawText: paper.rawText,
      })
      .returning({ id: papers.id });
    const paperId = insertedPaper.id;

    await tx.insert(extractions).values({
      paperId,
      extractionVersion: extraction.extractionVersion,
      problem: extraction.problem,
      priorWork: extraction.priorWork,
      method: extraction.method,
      results: extraction.results,
      limitations: extraction.limitations,
      keyTerms: extraction.keyTerms,
      datasetsUsed: extraction.datasetsUsed,
    });

    // Upsert each author by name (name is not unique in the schema, so dedupe
    // by lookup), then link via paper_authors with a zero-indexed position.
    for (let position = 0; position < finalAuthors.length; position++) {
      const name = finalAuthors[position];
      const found = await tx
        .select({ id: authors.id })
        .from(authors)
        .where(eq(authors.name, name))
        .limit(1);

      let authorId: string;
      if (found.length > 0) {
        authorId = found[0].id;
      } else {
        const [insertedAuthor] = await tx
          .insert(authors)
          .values({ name })
          .returning({ id: authors.id });
        authorId = insertedAuthor.id;
      }

      await tx.insert(paperAuthors).values({ paperId, authorId, position });
    }

    let claimsInserted = 0;
    if (extraction.claims.length > 0) {
      await tx.insert(claims).values(
        extraction.claims.map((claim) => ({
          paperId,
          text: claim.text,
          sourcePassage: claim.sourcePassage,
          confidence: claim.confidence,
        })),
      );
      claimsInserted = extraction.claims.length;
    }

    // Citations remain deferred (would require parsing references).

    await tx
      .update(papers)
      .set({ lastProcessedAt: new Date() })
      .where(eq(papers.id, paperId));

    return { paperId, claimsInserted };
  });

  console.log(`Done: ${result.paperId}`);
  return { ...result, alreadyIngested: false };
}
