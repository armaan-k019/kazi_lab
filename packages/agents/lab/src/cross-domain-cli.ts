import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, "../../../../.env.local") });

// Run lab-level cross-domain synthesis over the eligible (non-general,
// synthesized) libraries and print a grounded, honest report. Optional args are
// library names to restrict the scope; default is all eligible.
async function main(): Promise<void> {
  const { eq, inArray } = await import("drizzle-orm");
  const { db, libraries, crossDomainLinks, crossDomainLinkEvidence } =
    await import("@kazi-lab/db");
  const { runCrossDomainSynthesis } = await import("./cross-domain");

  // Resolve optional name args to ids.
  const nameArgs = process.argv.slice(2);
  let scopeIds: string[] | undefined;
  if (nameArgs.length) {
    const rows = await db
      .select({ id: libraries.id, name: libraries.name })
      .from(libraries)
      .where(inArray(libraries.name, nameArgs));
    scopeIds = rows.map((r) => r.id);
    console.log(`Scope restricted to: ${rows.map((r) => r.name).join(", ")}\n`);
  }

  const result = await runCrossDomainSynthesis(scopeIds);

  if (result.status === "insufficient") {
    console.log("INSUFFICIENT:", result.reason);
    console.log("eligible:", result.eligible.join(", ") || "(none)");
    console.log("skipped:", result.skipped.map((s) => `${s.name} (${s.reason})`).join("; ") || "(none)");
    process.exit(0);
  }
  if (result.status === "failed") {
    console.error("FAILED:", result.error);
    process.exit(1);
  }

  console.log("=== CROSS-DOMAIN RUN ===");
  console.log(`run: ${result.runId}`);
  console.log(`scope: ${result.scope.join(", ")}`);
  console.log(`skipped: ${result.skipped.map((s) => `${s.name} (${s.reason})`).join("; ") || "(none)"}`);
  console.log(
    `dropped links (insufficient grounding): ${result.droppedLinks} | dropped evidence (unresolved): ${result.droppedEvidence}`,
  );
  console.log("\n=== LINK COUNTS (grounded / candidate) ===");
  for (const level of ["method", "claim", "concept"] as const) {
    const c = result.counts[level];
    console.log(`  ${level}: grounded ${c.grounded}, candidate ${c.candidate}`);
  }

  // Pull the stored links + evidence for this run to print examples with provenance.
  const linkRows = await db
    .select()
    .from(crossDomainLinks)
    .where(eq(crossDomainLinks.crossDomainRunId, result.runId));
  const linkIds = linkRows.map((l) => l.id);
  const evRows = linkIds.length
    ? await db
        .select()
        .from(crossDomainLinkEvidence)
        .where(inArray(crossDomainLinkEvidence.linkId, linkIds))
    : [];
  const libRows = await db.select({ id: libraries.id, name: libraries.name }).from(libraries);
  const libName = new Map(libRows.map((l) => [l.id, l.name]));
  const evByLink = new Map<string, typeof evRows>();
  for (const e of evRows) {
    const arr = evByLink.get(e.linkId) ?? [];
    arr.push(e);
    evByLink.set(e.linkId, arr);
  }

  const printLink = (l: (typeof linkRows)[number]) => {
    console.log(
      `\n[${l.level}] ${l.isCandidate ? "CANDIDATE" : "GROUNDED"} (${l.confidence ?? "?"}) spans: ${l.libraryIds
        .map((id) => libName.get(id) ?? id)
        .join(" + ")}`,
    );
    console.log(`  ${l.summary}`);
    if (l.rationale) console.log(`  rationale: ${l.rationale}`);
    for (const e of evByLink.get(l.id) ?? []) {
      console.log(
        `  - [${libName.get(e.libraryId) ?? e.libraryId}] ${e.evidenceKind}: ${e.evidenceRef}${e.excerpt ? ` :: ${e.excerpt.slice(0, 120)}` : ""}`,
      );
    }
  };

  console.log("\n=== METHOD-LEVEL LINKS (with evidence) ===");
  const methodLinks = linkRows.filter((l) => l.level === "method");
  if (!methodLinks.length) console.log("  (none)");
  methodLinks.forEach(printLink);

  console.log("\n=== CLAIM-LEVEL LINKS (with evidence) ===");
  const claimLinks = linkRows.filter((l) => l.level === "claim");
  if (!claimLinks.length) console.log("  (none)");
  claimLinks.forEach(printLink);

  console.log("\n=== CONCEPT-LEVEL LINKS (candidates) ===");
  const conceptLinks = linkRows.filter((l) => l.level === "concept");
  if (!conceptLinks.length) console.log("  (none)");
  conceptLinks.forEach(printLink);

  console.log("\n=== HONEST READ ===");
  console.log(result.honestRead ?? "(none)");
  process.exit(0);
}

main().catch((error) => {
  console.error("Cross-domain run failed:");
  console.error(error);
  process.exit(1);
});
