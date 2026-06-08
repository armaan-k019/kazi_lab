import { and, cosineDistance, eq, inArray, sql } from "drizzle-orm";
import { db, embeddings, paperLibraries, papers } from "@kazi-lab/db";
import { embedQuery } from "./embeddings";

export type RetrievedChunk = {
  entityType: string; // "claim" | "paper"
  entityId: string;
  paperId: string;
  paperTitle: string;
  content: string;
  similarity: number; // cosine similarity in [-1, 1], higher is closer
};

// Library-scoped vector similarity search. Embeds the query, then finds the
// nearest claim/paper embeddings whose owning paper is in the given library.
// This is the grounded context the chatbot will retrieve over.
export async function retrieveRelevant(params: {
  query: string;
  libraryId: string;
  limit?: number;
  entityTypes?: ("claim" | "paper")[];
}): Promise<RetrievedChunk[]> {
  const limit = params.limit ?? 12;
  const qvec = await embedQuery(params.query);

  const distance = cosineDistance(embeddings.embedding, qvec);
  const similarity = sql<number>`1 - (${distance})`;

  const conditions = [eq(paperLibraries.libraryId, params.libraryId)];
  if (params.entityTypes && params.entityTypes.length > 0) {
    conditions.push(inArray(embeddings.entityType, params.entityTypes));
  }

  const rows = await db
    .select({
      entityType: embeddings.entityType,
      entityId: embeddings.entityId,
      paperId: embeddings.paperId,
      paperTitle: papers.title,
      content: embeddings.content,
      similarity,
    })
    .from(embeddings)
    .innerJoin(paperLibraries, eq(paperLibraries.paperId, embeddings.paperId))
    .innerJoin(papers, eq(papers.id, embeddings.paperId))
    .where(and(...conditions))
    .orderBy(distance) // ascending distance = most similar first
    .limit(limit);

  return rows;
}
