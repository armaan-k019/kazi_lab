import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { db, MODELS, openQuestions } from "@kazi-lab/db";
import { searchWorks } from "./openalex";
import { shapeCandidates, type DiscoveryCandidate } from "./external-candidates";

// Distilling an open question into a keyword query is structured reading, so it
// uses the shared extraction model (now Opus 4.8).
const DISTILL_MODEL = MODELS.extraction;
const RECENT_YEARS = 5;
const SLICE = 12;

export type QuestionSearchResult =
  | { found: false }
  | {
      found: true;
      question: string;
      searchQuery: string;
      candidates: DiscoveryCandidate[];
    };

// Turn a natural-language open question into a compact keyword query. Raw
// sentences search poorly. Falls back to the raw question on any failure.
async function distillQuery(question: string): Promise<string> {
  try {
    const client = new Anthropic();
    const r = await client.messages.create({
      model: DISTILL_MODEL,
      max_tokens: 120,
      system:
        "Turn the research question into 3 to 8 search keywords or short phrases optimized for academic literature search. Return ONLY the query string (space separated keywords and phrases), with no explanation, labels, or quotation marks.",
      messages: [{ role: "user", content: question }],
    });
    const block = r.content.find((b) => b.type === "text");
    const text = block && block.type === "text" ? block.text.trim() : "";
    return text.length > 0 ? text : question;
  } catch {
    return question;
  }
}

// Search recent literature for work addressing a synthesis open question.
export async function searchForOpenQuestion(
  questionId: string,
  libraryId: string,
): Promise<QuestionSearchResult> {
  const [q] = await db
    .select({ question: openQuestions.question })
    .from(openQuestions)
    .where(eq(openQuestions.id, questionId))
    .limit(1);
  if (!q) return { found: false };

  const searchQuery = await distillQuery(q.question);
  const fromDate = `${new Date().getUTCFullYear() - RECENT_YEARS}-01-01`;
  const works = await searchWorks(searchQuery, { fromDate, perPage: SLICE });
  const shaped = await shapeCandidates(works, libraryId);

  return {
    found: true,
    question: q.question,
    searchQuery,
    candidates: shaped.filter((c) => !c.inCorpus), // exclude in-corpus
  };
}
