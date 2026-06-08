import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

// Load the repo-root .env.local before anything reads ANTHROPIC_API_KEY or
// DATABASE_URL. Existing process.env values win.
const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, "../../../../.env.local") });

async function main(): Promise<void> {
  const arxivUrl = process.argv[2];
  if (!arxivUrl) {
    console.error(
      "Usage: pnpm --filter @kazi-lab/scribe ingest <arxiv-url>\n" +
        "Example: pnpm --filter @kazi-lab/scribe ingest https://arxiv.org/abs/2312.00738",
    );
    process.exit(1);
  }

  // Import after env is loaded so the db client and Anthropic client see it.
  const { ingestPaper } = await import("./ingest");
  const result = await ingestPaper(arxivUrl);

  console.log("");
  console.log(`paperId:        ${result.paperId}`);
  console.log(`claimsInserted: ${result.claimsInserted}`);
  if (result.alreadyIngested) {
    console.log("(paper was already in the corpus, nothing re-ingested)");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Ingestion failed:");
    console.error(error);
    process.exit(1);
  });
