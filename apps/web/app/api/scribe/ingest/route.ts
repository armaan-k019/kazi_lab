import { NextResponse } from "next/server";
import { ingestPaper } from "@kazi-lab/scribe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Ingest a paper from an arXiv URL or id. Runs entirely server-side; the
// Anthropic and database credentials never reach the client.
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const url =
    body && typeof body === "object" && "url" in body
      ? (body as { url: unknown }).url
      : undefined;

  if (typeof url !== "string" || url.trim().length === 0) {
    return NextResponse.json(
      { error: "Provide a URL (arXiv, PDF, or article) to ingest." },
      { status: 400 },
    );
  }

  try {
    const result = await ingestPaper(url.trim());
    return NextResponse.json(result);
  } catch (error) {
    console.error("POST /api/scribe/ingest failed:", error);
    const message = error instanceof Error ? error.message : String(error);

    if (/is not a valid url|could not parse an arxiv id/i.test(message)) {
      return NextResponse.json(
        { error: "That doesn't look like a valid URL or arXiv ID." },
        { status: 400 },
      );
    }
    if (/unsupported content type/i.test(message)) {
      return NextResponse.json(
        { error: message },
        { status: 415 },
      );
    }
    if (/could not extract (text|readable)/i.test(message)) {
      return NextResponse.json(
        {
          error:
            "Could not extract text from that source (it may be scanned, paywalled, or JavaScript-only).",
        },
        { status: 422 },
      );
    }
    if (/timed out/i.test(message)) {
      return NextResponse.json(
        { error: "The source took too long to fetch. Try again." },
        { status: 504 },
      );
    }
    if (
      /rate|429|503|service unavailable|too many requests|still unavailable/i.test(
        message,
      )
    ) {
      return NextResponse.json(
        { error: "arXiv is rate-limiting right now. Try again in a moment." },
        { status: 503 },
      );
    }
    if (/not found/i.test(message)) {
      return NextResponse.json(
        { error: "Source not found (404)." },
        { status: 404 },
      );
    }
    if (/failed to parse claude/i.test(message)) {
      return NextResponse.json(
        { error: "Extraction failed: the model returned unparseable output." },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { error: "Ingestion failed. Check the server logs." },
      { status: 500 },
    );
  }
}
