import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, "../../../../.env.local") });

// Usage: experiment <abstract|cross_domain_link|library> <ref-id>
async function main(): Promise<void> {
  const kind = process.argv[2] as "abstract" | "cross_domain_link" | "library";
  const ref = process.argv[3];
  if (!kind || !ref) {
    console.error("Usage: pnpm --filter @kazi-lab/experimentalist experiment <abstract|cross_domain_link|library> <ref-id>");
    process.exit(1);
  }
  const { eq } = await import("drizzle-orm");
  const { db, experimentalistRuns, metaAnalyses, experimentSpecs, qualitativeEvidence } =
    await import("@kazi-lab/db");
  const { runExperiment } = await import("./experimentalist");

  const result = await runExperiment(kind, ref);
  if (result.status === "failed_precondition") {
    console.log("PRECONDITION:", result.reason);
    process.exit(0);
  }
  if (result.status === "failed") {
    console.error("FAILED:", result.error);
    process.exit(1);
  }

  console.log("=== EXPERIMENTALIST RUN ===");
  console.log(`run: ${result.runId}`);
  console.log(`claim: ${result.claim}`);
  console.log(`scope: ${result.scope.join(", ")}`);
  console.log(`quantitative libraries: ${result.quantitativeLibraries.join(", ") || "(none)"}`);
  console.log(`qualitative-only libraries: ${result.qualitativeLibraries.join(", ") || "(none)"}`);
  console.log(`pooled slices: ${result.sliceCount} | single-paper slices excluded: ${result.droppedSinglePaper} | variance subsets: ${result.varianceSubsets}`);
  console.log(`interpretation verdict: ${result.interpretationVerdict ?? "?"}`);
  console.log(`dropped refs: interpretation ${result.droppedInterpretationRefs}, spec ${result.droppedSpecRefs}`);
  if (result.notes) console.log(`notes: ${result.notes}`);

  // Computed tables (best_median rows carry the pooled methods).
  const metaRows = await db.select().from(metaAnalyses).where(eq(metaAnalyses.runId, result.runId));
  const byKey = new Map<string, typeof metaRows>();
  for (const m of metaRows) {
    const k = `${m.keyDataset} | ${m.keyMetric} | ${m.keyTask} | ${m.keyConditions}`;
    const arr = byKey.get(k) ?? [];
    arr.push(m);
    byKey.set(k, arr);
  }
  console.log("\n=== COMPUTED POOLED KEYS ===");
  for (const [k, kinds] of byKey) {
    const bm = kinds.find((x) => x.poolKind === "best_median");
    console.log(`\n[${k}] papers=${bm?.nPapers} methods=${bm?.nMethods} kinds=[${kinds.map((x) => x.poolKind).join(", ")}]`);
    const methods = (bm?.computed as { methods?: { method: string; pooledValue: number; pooledFromSelf: boolean; conflict: boolean }[] })?.methods ?? [];
    const ranks = (kinds.find((x) => x.poolKind === "rank")?.computed as { ranks?: { method: string; meanRank: number; nPapers: number }[] })?.ranks ?? [];
    const rankByM = new Map(ranks.map((r) => [r.method, r]));
    for (const m of methods.slice(0, 8)) {
      const rk = rankByM.get(m.method);
      console.log(`   ${m.method} = ${m.pooledValue}${m.pooledFromSelf ? " (self)" : ""}${m.conflict ? " [CONFLICT]" : ""} | meanRank ${rk ? rk.meanRank.toFixed(2) : "-"}/${rk?.nPapers ?? 0}p`);
    }
    const vw = kinds.find((x) => x.poolKind === "variance_weighted_subset");
    if (vw) console.log(`   VARIANCE SUBSET: ${(vw.computed as { note?: string }).note ?? ""}`);
  }

  // Qualitative evidence.
  const qual = await db.select().from(qualitativeEvidence).where(eq(qualitativeEvidence.runId, result.runId));
  if (qual.length) {
    console.log("\n=== QUALITATIVE EVIDENCE (metric-less libraries) ===");
    for (const q of qual.slice(0, 8)) console.log(`   [${q.findingRef}] ${q.excerpt}`);
    console.log(`   (${qual.length} qualitative finding(s); note: ${qual[0].relevanceNote})`);
  }

  // Interpretation + spec.
  const [runRow] = await db.select().from(experimentalistRuns).where(eq(experimentalistRuns.id, result.runId));
  const interp = runRow.interpretation as { verdict?: string; text?: string; caveats?: string[]; unknowns?: string[] } | null;
  console.log("\n=== INTERPRETATION (LLM, constrained to computed numbers) ===");
  console.log(`verdict: ${interp?.verdict ?? "?"}`);
  console.log(interp?.text ?? "(none)");
  if (interp?.caveats?.length) console.log(`caveats: ${interp.caveats.join(" | ")}`);
  if (interp?.unknowns?.length) console.log(`unknowns: ${interp.unknowns.join(" | ")}`);

  const [spec] = await db.select().from(experimentSpecs).where(eq(experimentSpecs.runId, result.runId));
  if (spec) {
    console.log("\n=== EXPERIMENT SPEC ===");
    console.log(`title: ${spec.title}`);
    console.log(`objective: ${spec.objective}`);
    const design = spec.design as { arms?: string[]; held_fixed?: string[]; procedure?: string } | null;
    console.log(`arms: ${(design?.arms ?? []).map((a) => `\n   - ${a}`).join("")}`);
    console.log(`confirm: ${spec.confirmCriteria}`);
    console.log(`refute: ${spec.refuteCriteria}`);
    const env = spec.environment as { dependencies?: string[]; datasets?: string[]; hardware?: string; scale_notes?: string } | null;
    console.log(`environment: deps=${(env?.dependencies ?? []).join(", ")}; datasets=${(env?.datasets ?? []).join(", ")}; hardware=${env?.hardware ?? "?"}`);
    console.log(`verification harness: ${spec.verificationHarness}`);
    console.log(`human decisions: ${(spec.humanDecisions as string[] | null)?.join(" | ") ?? "(none)"}`);
    console.log(`limitations: ${spec.limitations}`);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error("Experimentalist run failed:");
  console.error(error);
  process.exit(1);
});
