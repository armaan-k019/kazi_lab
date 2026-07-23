import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, "../../../../.env.local") });

async function main(): Promise<void> {
  const { backfillCitations } = await import("./citations-backfill");
  const r = await backfillCitations();
  console.log("=== CITATIONS BACKFILL (Semantic Scholar) ===");
  console.log(`Semantic Scholar access: ${r.keyStatus}`);
  console.log(`papers processed: ${r.papersProcessed} | resolved: ${r.papersResolved}`);
  console.log(`citation edges created: ${r.edgesCreated} | linked to corpus: ${r.linkedToCorpus}`);
  console.log(`skipped (unresolved): ${r.skipped.length}`);
  for (const s of r.skipped.slice(0, 15)) console.log(`  - ${s.title}: ${s.reason}`);
  process.exit(0);
}

main().catch((error) => {
  console.error("Citations backfill failed:");
  console.error(error);
  process.exit(1);
});
