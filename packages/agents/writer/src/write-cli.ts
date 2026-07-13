import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, "../../../../.env.local") });

// Usage: write [experimentalistRunId]   (defaults to the latest completed run)
async function main(): Promise<void> {
  const ref = process.argv[2];
  const { eq } = await import("drizzle-orm");
  const { db, writerRuns, researchDocuments } = await import("@kazi-lab/db");
  const { runWriter } = await import("./write-document");

  const result = await runWriter(ref);
  if (result.status === "nothing") {
    console.log("NOTHING:", result.reason);
    process.exit(0);
  }
  if (result.status === "failed") {
    console.error("FAILED:", result.error);
    process.exit(1);
  }

  console.log("=== WRITER RUN ===");
  console.log(`writer run: ${result.writerRunId}`);
  console.log(`title: ${result.title}`);
  console.log(`sections: ${result.sectionCount} | dropped refs: ${result.droppedRefs} | unverified numbers: ${result.unverifiedNumbers}`);
  console.log(`conferences considered: ${result.conferencesConsidered.join(", ") || "(none)"}`);
  if (result.notes) console.log(`notes: ${result.notes}`);

  const [doc] = await db.select().from(researchDocuments).where(eq(researchDocuments.writerRunId, result.writerRunId)).limit(1);
  const sections = doc.sections as { key: string; heading: string; body: string; kind: string }[];
  const prov = (doc.provenance as Record<string, string[]>) ?? {};
  console.log("\n=== DOCUMENT ===");
  for (const s of sections) {
    console.log(`\n## ${s.heading}  [kind=${s.kind}; provenance=${(prov[s.key] ?? []).length} ref(s)]`);
    console.log(s.body);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error("Writer run failed:");
  console.error(error);
  process.exit(1);
});
