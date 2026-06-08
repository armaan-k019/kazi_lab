import { NextResponse } from "next/server";
import { searchForOpenQuestion } from "@kazi-lab/scribe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// "Find recent work on this": distill an open question into a search query and
// return recent literature candidates plus the query used (for transparency).
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const questionId = searchParams.get("questionId") ?? "";
  const libraryId = searchParams.get("libraryId") ?? "";
  if (!questionId || !libraryId) {
    return NextResponse.json(
      { error: "questionId and libraryId are required." },
      { status: 400 },
    );
  }
  try {
    const result = await searchForOpenQuestion(questionId, libraryId);
    if (!result.found) {
      return NextResponse.json({ error: "Question not found." }, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (error) {
    console.error("GET /api/external/question-search failed:", error);
    return NextResponse.json(
      { error: "Could not search the literature (OpenAlex or model error)." },
      { status: 502 },
    );
  }
}
