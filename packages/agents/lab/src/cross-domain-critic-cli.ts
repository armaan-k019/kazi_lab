import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, "../../../../.env.local") });

// Run the cross-domain Critic on the latest completed cross-domain run (or a
// given run id) and print the verdict distribution, verbatim rationales, and
// discovery results for an honest calibration read.
async function main(): Promise<void> {
  const runArg = process.argv[2];
  const { eq, inArray } = await import("drizzle-orm");
  const { db, crossDomainLinks, crossDomainLinkEvidence, linkVerdicts, libraries } =
    await import("@kazi-lab/db");
  const { runCrossDomainCritique } = await import("./cross-domain-critic");

  const result = await runCrossDomainCritique(runArg);
  if (result.status === "nothing") {
    console.log("NOTHING:", result.reason);
    process.exit(0);
  }
  if (result.status === "failed") {
    console.error("FAILED:", result.error);
    process.exit(1);
  }

  console.log("=== CROSS-DOMAIN CRITIQUE ===");
  console.log(`critic run: ${result.criticRunId}`);
  console.log(`audited cross-domain run: ${result.crossDomainRunId}`);
  console.log(`dropped verdicts: ${result.droppedVerdicts} | dropped discovered: ${result.droppedDiscovered}`);
  if (result.notes) console.log(`notes: ${result.notes}`);

  console.log("\n=== VERDICT DISTRIBUTION ===");
  console.log(`overall: confirmed ${result.verdicts.confirmed}, promoted ${result.verdicts.promoted}, demoted ${result.verdicts.demoted}, rejected ${result.verdicts.rejected}`);
  console.log(`of GROUNDED links: confirmed ${result.grounded.confirmed}, demoted ${result.grounded.demoted}, rejected ${result.grounded.rejected}`);
  console.log(`of CANDIDATE links: promoted ${result.candidate.promoted}, demoted-in-place ${result.candidate.demoted}, rejected ${result.candidate.rejected}`);
  console.log(`discovered: ${result.discovered}`);

  // Pull the verdicts joined to their links so we can print rationales.
  const vRows = await db
    .select({
      verdict: linkVerdicts.verdict,
      rationale: linkVerdicts.rationale,
      confidence: linkVerdicts.confidence,
      linkId: linkVerdicts.linkId,
    })
    .from(linkVerdicts)
    .where(eq(linkVerdicts.criticRunId, result.criticRunId));
  const linkRows = await db
    .select({
      id: crossDomainLinks.id,
      level: crossDomainLinks.level,
      summary: crossDomainLinks.summary,
      isCandidate: crossDomainLinks.isCandidate,
      source: crossDomainLinks.source,
      libraryIds: crossDomainLinks.libraryIds,
    })
    .from(crossDomainLinks)
    .where(eq(crossDomainLinks.crossDomainRunId, result.crossDomainRunId));
  const linkById = new Map(linkRows.map((l) => [l.id, l]));
  const libRows = await db.select({ id: libraries.id, name: libraries.name }).from(libraries);
  const libName = new Map(libRows.map((l) => [l.id, l.name]));

  console.log("\n=== VERDICTS WITH RATIONALES ===");
  for (const v of vRows) {
    const l = linkById.get(v.linkId);
    console.log(
      `\n[${v.verdict.toUpperCase()}] (${v.confidence ?? "?"}) ${l?.level ?? "?"} :: ${l ? l.libraryIds.map((id) => libName.get(id) ?? id).join(" + ") : "?"}`,
    );
    console.log(`  link: ${l?.summary ?? "(missing)"}`);
    console.log(`  rationale: ${v.rationale ?? "(none)"}`);
  }

  // Discovered links (source = discovery) in the audited run.
  const discoveredLinks = linkRows.filter((l) => l.source === "discovery");
  console.log("\n=== DISCOVERED LINKS (candidates, needs validation) ===");
  if (!discoveredLinks.length) {
    console.log("  none found that met the bar.");
  } else {
    const dIds = discoveredLinks.map((l) => l.id);
    const dEv = await db
      .select()
      .from(crossDomainLinkEvidence)
      .where(inArray(crossDomainLinkEvidence.linkId, dIds));
    const evByLink = new Map<string, typeof dEv>();
    for (const e of dEv) {
      const arr = evByLink.get(e.linkId) ?? [];
      arr.push(e);
      evByLink.set(e.linkId, arr);
    }
    for (const l of discoveredLinks) {
      console.log(`\n[${l.level}] ${l.libraryIds.map((id) => libName.get(id) ?? id).join(" + ")}`);
      console.log(`  ${l.summary}`);
      for (const e of evByLink.get(l.id) ?? []) {
        console.log(`  - [${libName.get(e.libraryId) ?? e.libraryId}] ${e.evidenceKind}: ${e.evidenceRef}`);
      }
    }
  }
  process.exit(0);
}

main().catch((error) => {
  console.error("Cross-domain critique failed:");
  console.error(error);
  process.exit(1);
});
