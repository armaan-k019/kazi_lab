import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, "../../../../.env.local") });

// Usage: propose [webRunId]   (defaults to the latest completed web build)
async function main(): Promise<void> {
  const webRunId = process.argv[2];
  const { eq } = await import("drizzle-orm");
  const { db, crossDomainLinks, crossDomainLinkEvidence } = await import("@kazi-lab/db");
  const { proposeCrossovers } = await import("./propose");

  const result = await proposeCrossovers(webRunId);
  if (result.status === "nothing") {
    console.log("NOTHING:", result.reason);
    process.exit(0);
  }
  console.log("=== CROSSOVER PROPOSALS ===");
  console.log(`web run: ${result.webRunId}`);
  console.log(`cross_domain_run: ${result.crossDomainRunId ?? "(none created)"}`);
  console.log(`proposed: ${result.proposed} | dropped (no grounding): ${result.droppedNoGrounding}`);
  if (result.note) console.log(`note: ${result.note}`);
  if (result.critique) console.log(`auto-audit verdicts: ${JSON.stringify(result.critique)}`);

  if (result.crossDomainRunId) {
    const links = await db.select().from(crossDomainLinks).where(eq(crossDomainLinks.crossDomainRunId, result.crossDomainRunId));
    console.log("\n=== PROPOSALS VERBATIM ===");
    for (const l of links.filter((x) => x.source === "web_discovery")) {
      console.log(`\n[${l.level}] ${l.summary}`);
      console.log(`  rationale: ${l.rationale}`);
      const ev = await db.select().from(crossDomainLinkEvidence).where(eq(crossDomainLinkEvidence.linkId, l.id));
      for (const e of ev) console.log(`  - [${e.evidenceKind}] ${e.evidenceRef}: ${(e.excerpt ?? "").slice(0, 90)}`);
    }
  }
  process.exit(0);
}

main().catch((error) => {
  console.error("Propose run failed:");
  console.error(error);
  process.exit(1);
});
