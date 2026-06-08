import { sql } from "drizzle-orm";
import { db, embeddings } from "@kazi-lab/db";
import { embedTexts, EMBEDDING_MODEL } from "./embeddings";

// Paper-level summary text to embed: the extraction fields concatenated.
export function buildPaperSummary(parts: {
  problem?: string | null;
  method?: string | null;
  results?: string | null;
  limitations?: string | null;
}): string {
  return [parts.problem, parts.method, parts.results, parts.limitations]
    .map((s) => (s ?? "").trim())
    .filter((s) => s.length > 0)
    .join("\n\n")
    .trim();
}

// Embed a paper's claims (each as a document) and its summary, then upsert into
// the embeddings table keyed by (entity_type, entity_id), so re-embedding
// replaces rather than duplicates.
export async function embedAndStorePaper(args: {
  paperId: string;
  claims: { id: string; text: string }[];
  summary: string | null;
}): Promise<{ claimCount: number; paperSummary: boolean }> {
  const items: {
    entityType: "claim" | "paper";
    entityId: string;
    content: string;
  }[] = [];
  for (const c of args.claims) {
    if (c.text && c.text.trim().length > 0) {
      items.push({ entityType: "claim", entityId: c.id, content: c.text });
    }
  }
  if (args.summary && args.summary.trim().length > 0) {
    items.push({
      entityType: "paper",
      entityId: args.paperId,
      content: args.summary,
    });
  }
  if (items.length === 0) return { claimCount: 0, paperSummary: false };

  const vectors = await embedTexts(
    items.map((i) => i.content),
    "document",
  );

  const rows = items.map((it, i) => ({
    entityType: it.entityType,
    entityId: it.entityId,
    paperId: args.paperId,
    embedding: vectors[i],
    model: EMBEDDING_MODEL,
    content: it.content,
  }));

  await db
    .insert(embeddings)
    .values(rows)
    .onConflictDoUpdate({
      target: [embeddings.entityType, embeddings.entityId],
      set: {
        embedding: sql`excluded.embedding`,
        content: sql`excluded.content`,
        model: sql`excluded.model`,
        paperId: sql`excluded.paper_id`,
        createdAt: sql`now()`,
      },
    });

  return {
    claimCount: items.filter((i) => i.entityType === "claim").length,
    paperSummary: items.some((i) => i.entityType === "paper"),
  };
}
