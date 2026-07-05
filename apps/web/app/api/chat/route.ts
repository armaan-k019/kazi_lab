import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { db, libraries, MODELS } from "@kazi-lab/db";
import { retrieveRelevant } from "@kazi-lab/scribe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Retrieval cosine scores run ~0.47-0.66 for on-topic and ~0.35 for off-topic
// (clear gap), so a floor of 0.45 separates "the library covers this" from
// "it does not". Below the floor we refuse rather than answer from general
// knowledge. This is the core of the grounding contract.
const SIMILARITY_FLOOR = 0.45;
const RETRIEVE_LIMIT = 12;
// The interactive research chat assistant uses the shared chat model (Opus 4.8).
const MODEL = MODELS.chat;
const MAX_TOKENS = 1024;
const MAX_HISTORY = 6;

type Chunk = {
  entityType: string;
  paperId: string;
  paperTitle: string;
  content: string;
  similarity: number;
};

function distinctPapers(chunks: Chunk[]): { paperId: string; paperTitle: string }[] {
  const seen = new Set<string>();
  const out: { paperId: string; paperTitle: string }[] = [];
  for (const c of chunks) {
    if (!seen.has(c.paperId)) {
      seen.add(c.paperId);
      out.push({ paperId: c.paperId, paperTitle: c.paperTitle });
    }
  }
  return out;
}

function buildSystemPrompt(libraryName: string, chunks: Chunk[]): string {
  const sources = chunks
    .map((c) => `[${c.paperTitle}] ${c.content}`)
    .join("\n\n");
  return `You are the corpus assistant for a research library called ${libraryName}. Answer the user's question using ONLY the provided source material from this library. The sources are claims and summaries extracted from the library's papers, each labeled with its paper title.

Rules:
- Answer ONLY from the provided sources. Do not use outside knowledge.
- Cite the specific papers you draw from, by title, inline or at the end.
- If the sources only partially address the question, answer what you can and say what is missing.
- If the sources do NOT actually address the question, say clearly that this library does not cover it. Do not fall back on general knowledge.
- Be specific and concise. Prefer the papers' actual findings and numbers over vague summary.

Sources:
${sources}`;
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const obj = (body ?? {}) as {
    libraryId?: unknown;
    question?: unknown;
    history?: unknown;
  };
  const libraryId = typeof obj.libraryId === "string" ? obj.libraryId : "";
  const question = typeof obj.question === "string" ? obj.question.trim() : "";
  if (!libraryId) {
    return NextResponse.json({ error: "libraryId is required." }, { status: 400 });
  }
  if (!question) {
    return NextResponse.json({ error: "A question is required." }, { status: 400 });
  }

  const history = Array.isArray(obj.history)
    ? (obj.history as unknown[])
        .filter(
          (h): h is { role: "user" | "assistant"; content: string } =>
            !!h &&
            typeof h === "object" &&
            ((h as { role?: unknown }).role === "user" ||
              (h as { role?: unknown }).role === "assistant") &&
            typeof (h as { content?: unknown }).content === "string",
        )
        .slice(-MAX_HISTORY)
    : [];

  try {
    const [library] = await db
      .select({ name: libraries.name })
      .from(libraries)
      .where(eq(libraries.id, libraryId))
      .limit(1);
    if (!library) {
      return NextResponse.json({ error: "Library not found." }, { status: 404 });
    }

    const chunks = (await retrieveRelevant({
      query: question,
      libraryId,
      limit: RETRIEVE_LIMIT,
    })) as Chunk[];

    const best = chunks[0]?.similarity ?? -1;

    // Refusal path: nothing in the library is relevant enough. We refuse
    // deterministically (no model call) so there is zero chance of a
    // general-knowledge answer leaking through.
    if (best < SIMILARITY_FLOOR) {
      const covers = distinctPapers(chunks)
        .slice(0, 4)
        .map((p) => p.paperTitle);
      const coversText = covers.length
        ? ` The papers here focus on work like ${covers.join("; ")}.`
        : "";
      return NextResponse.json({
        answer: `This library does not contain material that addresses that.${coversText}`,
        citations: [],
        usedChunks: chunks.slice(0, 5).map((c) => ({
          paperTitle: c.paperTitle,
          content: c.content,
          similarity: c.similarity,
          entityType: c.entityType,
        })),
        refused: true,
      });
    }

    // Grounded path: answer ONLY from the chunks that cleared the floor.
    const grounding = chunks.filter((c) => c.similarity >= SIMILARITY_FLOOR);
    const client = new Anthropic();
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: buildSystemPrompt(library.name, grounding),
      messages: [
        ...history.map((h) => ({ role: h.role, content: h.content })),
        { role: "user" as const, content: question },
      ],
    });
    const textBlock = response.content.find((b) => b.type === "text");
    const answer = textBlock && textBlock.type === "text" ? textBlock.text : "";

    return NextResponse.json({
      answer,
      citations: distinctPapers(grounding),
      usedChunks: grounding.map((c) => ({
        paperTitle: c.paperTitle,
        content: c.content,
        similarity: c.similarity,
        entityType: c.entityType,
      })),
      refused: false,
    });
  } catch (error) {
    console.error("POST /api/chat failed:", error);
    return NextResponse.json(
      { error: "The assistant could not answer. Try again." },
      { status: 500 },
    );
  }
}
