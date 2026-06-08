import { eq } from "drizzle-orm";
import {
  authors,
  claims,
  db,
  extractions,
  libraries,
  paperAuthors,
  paperLibraries,
  papers,
} from "@kazi-lab/db";
import { fetchSource } from "./fetch-source";
import { extractPaperFields } from "./extractor";

export type IngestResult = {
  paperId: string;
  claimsInserted: number;
  alreadyIngested: boolean; // kept for the existing UI; true when we linked an existing paper
  linkedExisting: boolean;
  libraryId: string;
};

// Resolve the target library: the given id (validated), or the default
// "general" library (created if it somehow doesn't exist yet).
async function resolveLibraryId(libraryId?: string): Promise<string> {
  if (libraryId) {
    const [lib] = await db
      .select({ id: libraries.id })
      .from(libraries)
      .where(eq(libraries.id, libraryId))
      .limit(1);
    if (!lib) throw new Error(`Library not found: ${libraryId}`);
    return lib.id;
  }
  const [general] = await db
    .select({ id: libraries.id })
    .from(libraries)
    .where(eq(libraries.name, "general"))
    .limit(1);
  if (general) return general.id;
  const [created] = await db
    .insert(libraries)
    .values({ name: "general", description: "Default library." })
    .returning({ id: libraries.id });
  return created.id;
}

export async function ingestPaper(
  url: string,
  libraryId?: string,
): Promise<IngestResult> {
  console.log(`Fetching source: ${url}`);
  const paper = await fetchSource(url);
  console.log(
    `Fetched ${paper.sourceType} source: "${paper.title || "(untitled)"}"`,
  );

  const targetLibraryId = await resolveLibraryId(libraryId);

  // Dedupe before the (costly) extraction call. arXiv keys on arxiv_id; other
  // sources key on the canonical URL. A known paper is linked to the target
  // library rather than re-extracted.
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
    const paperId = existing[0].id;
    await db
      .insert(paperLibraries)
      .values({ paperId, libraryId: targetLibraryId })
      .onConflictDoNothing();
    console.log(`Already ingested: ${paperId}. Linked to library.`);
    return {
      paperId,
      claimsInserted: 0,
      alreadyIngested: true,
      linkedExisting: true,
      libraryId: targetLibraryId,
    };
  }

  console.log("Extracting with Claude...");
  const extraction = await extractPaperFields(paper);
  console.log(`Extracted ${extraction.claims.length} claims.`);

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

    // Link the new paper to the target library.
    await tx
      .insert(paperLibraries)
      .values({ paperId, libraryId: targetLibraryId })
      .onConflictDoNothing();

    await tx
      .update(papers)
      .set({ lastProcessedAt: new Date() })
      .where(eq(papers.id, paperId));

    return { paperId, claimsInserted };
  });

  console.log(`Done: ${result.paperId}`);
  return {
    ...result,
    alreadyIngested: false,
    linkedExisting: false,
    libraryId: targetLibraryId,
  };
}
