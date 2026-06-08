import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

// Load the repo-root .env.local before anything reads ANTHROPIC_API_KEY or
// DATABASE_URL. Existing process.env values win.
const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, "../../../../.env.local") });

async function main(): Promise<void> {
  const libraryId = process.argv[2];
  if (!libraryId) {
    console.error(
      "Usage: pnpm --filter @kazi-lab/scribe synthesize <libraryId>",
    );
    process.exit(1);
  }

  const { synthesizeLibrary } = await import("./synthesize");
  const r = await synthesizeLibrary(libraryId);

  console.log("");
  console.log(`runId:             ${r.runId}`);
  console.log(`themes:            ${r.themeCount}`);
  console.log(`findings:          ${r.findingCount}`);
  console.log(`claim relations:   ${r.relationCount}`);
  console.log(`open questions:    ${r.openQuestionCount}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Synthesis failed:");
    console.error(error);
    process.exit(1);
  });
