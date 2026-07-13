import { desc, eq } from "drizzle-orm";
import { db, researchDocuments, writerRuns } from "@kazi-lab/db";
import { documentToMarkdown, type Section } from "@kazi-lab/writer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Download a research document as clean markdown. ?writerRunId= selects one;
// default is the latest completed writer run. A write-up's natural home is a file.
export async function GET(request: Request) {
  const writerRunId = new URL(request.url).searchParams.get("writerRunId");
  const [wRun] = writerRunId
    ? await db.select().from(writerRuns).where(eq(writerRuns.id, writerRunId)).limit(1)
    : await db
        .select()
        .from(writerRuns)
        .where(eq(writerRuns.status, "completed"))
        .orderBy(desc(writerRuns.completedAt))
        .limit(1);
  if (!wRun) {
    return new Response("No document found.", { status: 404 });
  }
  const [doc] = await db.select().from(researchDocuments).where(eq(researchDocuments.writerRunId, wRun.id)).limit(1);
  if (!doc) {
    return new Response("No document found.", { status: 404 });
  }
  const markdown = documentToMarkdown(doc.title, doc.sections as Section[]);
  const slug = (doc.title ?? "research-document")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return new Response(markdown, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${slug || "research-document"}.md"`,
    },
  });
}
