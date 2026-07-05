import { and, desc, eq } from "drizzle-orm";
import {
  criticAbstracts,
  criticRuns,
  crossDomainCriticRuns,
  crossDomainLinks,
  db,
  isAllPapersLibrary,
  libraries,
  linkVerdicts,
} from "@kazi-lab/db";

export type InputKind = "abstract" | "cross_domain_link" | "library";

export type ResolvedInput = {
  claim: string | null; // null for bare-library mode; derived later
  scopeLibraryIds: string[];
  warnings: string[];
};

// Resolve one of the three input modes to the shared { claim, scope } contract.
// General is never a valid scope. Throws on a missing/invalid ref so the caller
// can report it without creating a run.
export async function resolveInput(kind: InputKind, ref: string): Promise<ResolvedInput> {
  const warnings: string[] = [];

  if (kind === "abstract") {
    const [row] = await db
      .select({
        claimToTest: criticAbstracts.claimToTest,
        title: criticAbstracts.title,
        libraryId: criticRuns.libraryId,
        libraryName: libraries.name,
      })
      .from(criticAbstracts)
      .innerJoin(criticRuns, eq(criticRuns.id, criticAbstracts.criticRunId))
      .innerJoin(libraries, eq(libraries.id, criticRuns.libraryId))
      .where(eq(criticAbstracts.id, ref))
      .limit(1);
    if (!row) throw new Error(`Critic abstract not found: ${ref}`);
    if (isAllPapersLibrary(row.libraryName)) {
      throw new Error("The general library is not a valid evidence scope.");
    }
    const claim = (row.claimToTest ?? row.title ?? "").trim();
    if (!claim) throw new Error("This Critic abstract has no claim_to_test to seed the experiment.");
    return { claim, scopeLibraryIds: [row.libraryId], warnings };
  }

  if (kind === "cross_domain_link") {
    const [link] = await db
      .select({
        id: crossDomainLinks.id,
        summary: crossDomainLinks.summary,
        libraryIds: crossDomainLinks.libraryIds,
        crossDomainRunId: crossDomainLinks.crossDomainRunId,
      })
      .from(crossDomainLinks)
      .where(eq(crossDomainLinks.id, ref))
      .limit(1);
    if (!link) throw new Error(`Cross-domain link not found: ${ref}`);

    // The link's latest verdict, if it has been critiqued. Warn (do not block) if
    // the skeptic rejected it: testing a rejected recurrence is allowed but noted.
    const [verdict] = await db
      .select({ verdict: linkVerdicts.verdict, completedAt: crossDomainCriticRuns.completedAt })
      .from(linkVerdicts)
      .innerJoin(crossDomainCriticRuns, eq(crossDomainCriticRuns.id, linkVerdicts.criticRunId))
      .where(
        and(
          eq(linkVerdicts.linkId, link.id),
          eq(crossDomainCriticRuns.status, "completed"),
        ),
      )
      .orderBy(desc(crossDomainCriticRuns.completedAt))
      .limit(1);
    if (verdict?.verdict === "rejected") {
      warnings.push("The cross-domain Critic REJECTED this link as superficial; testing it anyway.");
    } else if (verdict?.verdict) {
      warnings.push(`Link's latest cross-domain Critic verdict: ${verdict.verdict}.`);
    }

    // Filter general out of scope, keep only real libraries.
    const libs = await db
      .select({ id: libraries.id, name: libraries.name })
      .from(libraries);
    const nameById = new Map(libs.map((l) => [l.id, l.name]));
    const scope = link.libraryIds.filter((id) => !isAllPapersLibrary(nameById.get(id)));
    if (scope.length < 1) throw new Error("This link has no valid (non-general) libraries in scope.");
    const claim = `Test whether this cross-domain recurrence holds as a load-bearing, mechanistic claim: ${link.summary}`;
    return { claim, scopeLibraryIds: scope, warnings };
  }

  // Bare library: claim is derived downstream from the audited synthesis.
  const [lib] = await db
    .select({ id: libraries.id, name: libraries.name })
    .from(libraries)
    .where(eq(libraries.id, ref))
    .limit(1);
  if (!lib) throw new Error(`Library not found: ${ref}`);
  if (isAllPapersLibrary(lib.name)) {
    throw new Error("The general library is not a valid evidence scope.");
  }
  return { claim: null, scopeLibraryIds: [lib.id], warnings };
}
