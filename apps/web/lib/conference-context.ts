import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { db, libraryConferences } from "@kazi-lab/db";
import { fetchSource } from "@kazi-lab/scribe";

// Conference context is a cheap structuring task, so it uses Sonnet. HARD
// BOUNDARY: this only ever writes to library_conferences. The fetched/pasted
// source text is NEVER inserted into papers/extractions/claims/embeddings and
// never enters Scribe synthesis. It is venue context only.
const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 1500;
const SOURCE_CAP = 40_000;

const SYSTEM_PROMPT = `You extract structured context about an academic conference or venue from its call-for-papers or description text. Return ONLY valid JSON (no markdown, no commentary) matching:
{ "themes": ["short topic phrase", ...], "key_dates": ["label: date", ...], "scope_summary": "1-3 sentences on what work fits this venue" }
themes: the topics and areas of interest the venue solicits (about 5 to 15 short phrases). key_dates: submission, notification, and camera-ready deadlines as "label: date" strings if present, otherwise an empty array. Do not invent dates that are not in the text. If the text is not actually a conference or venue description, return empty arrays and a one-line scope_summary saying so.`;

type Parsed = {
  themes?: unknown;
  key_dates?: unknown;
  scope_summary?: unknown;
};

function strArray(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).slice(0, 20)
    : [];
}

// Fetch/parse a conference entry's source and synthesize themes/dates/scope.
// Re-runnable (overwrites prior synthesis). Never throws: a failure sets
// synth_status="failed" with a note.
export async function synthesizeConferenceSource(
  conferenceId: string,
): Promise<{ status: "synthesized" | "failed"; note?: string }> {
  const [conf] = await db
    .select()
    .from(libraryConferences)
    .where(eq(libraryConferences.id, conferenceId))
    .limit(1);
  if (!conf) return { status: "failed", note: "Conference not found." };

  const fail = async (note: string) => {
    await db
      .update(libraryConferences)
      .set({ synthStatus: "failed", notes: note.slice(0, 200), updatedAt: new Date() })
      .where(eq(libraryConferences.id, conferenceId))
      .catch(() => {});
    return { status: "failed" as const, note };
  };

  try {
    // Resolve source text. A URL is fetched with the existing generic fetcher
    // (Readability/PDF); pasted text/pdf-text is used directly.
    let text = (conf.rawSourceText ?? "").trim();
    if (conf.sourceKind === "url" && conf.sourceUrl) {
      const src = await fetchSource(conf.sourceUrl);
      text = (src.rawText ?? "").trim();
    }
    if (!text) return fail("No source text to synthesize.");
    const capped = text.slice(0, SOURCE_CAP);

    const client = new Anthropic();
    const response = await client.messages
      .stream({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [
          { role: "user", content: `Conference: ${conf.name}\n\nSource text:\n${capped}` },
        ],
      })
      .finalMessage();

    const truncated = response.stop_reason === "max_tokens";
    const block = response.content.find((b) => b.type === "text");
    const raw = block && block.type === "text" ? block.text : "";
    const fenced = raw.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
    let parsed: Parsed;
    try {
      parsed = JSON.parse(fenced ? fenced[1].trim() : raw.trim()) as Parsed;
    } catch {
      return fail(truncated ? "Output truncated; could not parse." : "Could not parse conference synthesis.");
    }

    await db
      .update(libraryConferences)
      .set({
        themes: strArray(parsed.themes),
        keyDates: strArray(parsed.key_dates),
        scopeSummary:
          typeof parsed.scope_summary === "string" ? parsed.scope_summary : null,
        rawSourceText: capped, // persist the used text so re-synth works
        synthStatus: "synthesized",
        notes: truncated ? "Output truncated; context may be incomplete." : null,
        updatedAt: new Date(),
      })
      .where(eq(libraryConferences.id, conferenceId));
    return { status: "synthesized" };
  } catch (e) {
    return fail(`Synthesis failed: ${(e instanceof Error ? e.message : String(e))}`);
  }
}
