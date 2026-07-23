import { resetCorpus } from "./reset";

// Guarded, irreversible corpus reset. Requires RESET_CONFIRM=1 so it can never
// fire accidentally. Reports deleted counts per table and confirms zero remain.
async function main(): Promise<void> {
  if (process.env.RESET_CONFIRM !== "1") {
    console.error("Refusing to reset: set RESET_CONFIRM=1 to confirm this IRREVERSIBLE corpus wipe.");
    console.error("  RESET_CONFIRM=1 pnpm --filter @kazi-lab/db reset");
    process.exit(1);
  }

  console.log("Resetting corpus (irreversible)...");
  const { tables, before, after } = await resetCorpus();

  let totalDeleted = 0;
  let nonZeroRemaining = 0;
  console.log("\n=== DELETED ROW COUNTS (per table) ===");
  for (const t of tables) {
    const deleted = before[t] ?? 0;
    totalDeleted += deleted;
    if ((after[t] ?? 0) !== 0) nonZeroRemaining++;
    if (deleted > 0) console.log(`  ${t}: ${deleted} deleted, ${after[t]} remaining`);
  }
  console.log(`\ntotal rows deleted: ${totalDeleted} across ${tables.length} tables`);
  if (nonZeroRemaining === 0) {
    console.log("VERIFIED: zero rows remain in every table.");
    process.exit(0);
  } else {
    console.error(`FAILED: ${nonZeroRemaining} table(s) still have rows.`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Reset failed:");
  console.error(error);
  process.exit(1);
});
