import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, "../../../../.env.local") });

async function main(): Promise<void> {
  const { eq, desc } = await import("drizzle-orm");
  const { db, webBridges, webBuildRuns } = await import("@kazi-lab/db");
  const { buildWeb } = await import("./build-web");

  const result = await buildWeb();
  if (result.status === "empty") {
    console.log("EMPTY:", result.reason);
    process.exit(0);
  }
  if (result.status === "failed") {
    console.error("FAILED:", result.error);
    process.exit(1);
  }
  const s = result.stats as unknown as Record<string, unknown>;
  console.log("=== WEB BUILD ===");
  console.log(`run: ${result.runId}`);
  console.log("nodes:", JSON.stringify(s.nodes));
  console.log("edges:", JSON.stringify(s.edges));
  console.log("projection edges:", s.projectionEdges, "| citations:", s.citations);
  console.log("communities:", s.communities);
  console.log("\n=== COMMUNITY LABELS ===");
  for (const c of s.communityLabels as { index: number; size: number; label: string | null }[]) {
    console.log(`  [${c.index}] size ${c.size}: ${c.label ?? "(unlabeled)"}`);
  }
  console.log("\n=== ARI vs LIBRARIES ===");
  console.log(JSON.stringify(s.ari));
  console.log("\n=== ORPHAN REPORT ===");
  const orphan = s.orphanReport as { tinyCommunities: { community: number; size: number; papers: string[] }[]; lowDegreePapers: { title: string; projDegree: number; library: string }[] };
  console.log(`tiny communities (size <= 3): ${orphan.tinyCommunities.length}`);
  for (const t of orphan.tinyCommunities) console.log(`  community ${t.community} (${t.size}): ${t.papers.join(" | ")}`);
  console.log(`low-degree papers (projection degree <= 1): ${orphan.lowDegreePapers.length}`);
  for (const p of orphan.lowDegreePapers.slice(0, 20)) console.log(`  [deg ${p.projDegree}] ${p.title} (lib: ${p.library})`);

  // Top ABC candidates + bridges verbatim.
  const bridges = await db.select().from(webBridges).where(eq(webBridges.runId, result.runId));
  const abc = bridges.filter((b) => b.kind === "abc").sort((a, b) => b.score - a.score).slice(0, 5);
  console.log("\n=== TOP 5 ABC CANDIDATES ===");
  for (const a of abc) {
    const p = a.payload as { a_label: string; c_label: string; a_community: number; c_community: number; path_evidence: { b_label: string; a_leg_papers: { title: string }[]; c_leg_papers: { title: string }[] }[] };
    console.log(`\nscore ${a.score.toFixed(3)}: "${p.a_label}" (comm ${p.a_community}) --- "${p.c_label}" (comm ${p.c_community})`);
    for (const pe of (p.path_evidence ?? []).slice(0, 3)) {
      console.log(`   via "${pe.b_label}": A=[${pe.a_leg_papers.map((x) => x.title).join("; ")}] C=[${pe.c_leg_papers.map((x) => x.title).join("; ")}]`);
    }
  }
  const nodeBridges = bridges.filter((b) => b.kind === "node_bridge").sort((a, b) => b.score - a.score).slice(0, 3);
  console.log("\n=== TOP 3 NODE BRIDGES ===");
  for (const nb of nodeBridges) {
    const p = nb.payload as { title: string; communities: number[]; betweenness: number };
    console.log(`  betweenness ${nb.score.toFixed(4)}: "${p.title}" connects communities [${p.communities.join(", ")}]`);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error("Web build run failed:");
  console.error(error);
  process.exit(1);
});
