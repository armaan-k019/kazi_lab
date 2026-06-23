import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

// Load the repo-root .env.local before anything reads DATABASE_URL /
// ANTHROPIC_API_KEY.
const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, "../../../../.env.local") });

async function main(): Promise<void> {
  const libraryId = process.argv[2];
  if (!libraryId) {
    console.error("Usage: pnpm --filter @kazi-lab/critic critique <libraryId>");
    process.exit(1);
  }
  const { runCritique } = await import("./critique");
  const result = await runCritique(libraryId);
  console.log(JSON.stringify(result, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Critique failed:");
    console.error(error);
    process.exit(1);
  });
