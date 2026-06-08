import { eq, sql } from "drizzle-orm";
import {
  claimRelations,
  db,
  findings,
  openQuestions,
  themes,
} from "@kazi-lab/db";

export type SynthesisCountSet = {
  themeCount: number;
  findingCount: number;
  relationCount: number;
  openQuestionCount: number;
};

// Count synthesis output rows for a given run.
export async function countsForRun(runId: string): Promise<SynthesisCountSet> {
  const n = (rows: { n: number }[]) => rows[0]?.n ?? 0;
  const [t, f, r, q] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(themes)
      .where(eq(themes.synthesisRunId, runId)),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(findings)
      .where(eq(findings.synthesisRunId, runId)),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(claimRelations)
      .where(eq(claimRelations.synthesisRunId, runId)),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(openQuestions)
      .where(eq(openQuestions.synthesisRunId, runId)),
  ]);
  return {
    themeCount: n(t),
    findingCount: n(f),
    relationCount: n(r),
    openQuestionCount: n(q),
  };
}
