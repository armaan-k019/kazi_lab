// The special, undeletable catch-all library that holds every paper in the
// corpus. It is presented as a plain "all papers" view, not a synthesizable
// research library, so synthesis and discovery controls are hidden for it.
//
// This is a pure, dependency-free copy so client components can import it
// without pulling in @kazi-lab/db (which loads pg and cannot run in the
// browser). The server-side agents reuse the identical helper from
// @kazi-lab/db; both are kept in sync (see packages/db/library.ts).
export const GENERAL_LIBRARY_NAME = "general";

// Centralized check for "is this the general/all-papers library?". Reuse this
// everywhere instead of scattering the "general" string literal.
export function isAllPapersLibrary(
  name: string | null | undefined,
): boolean {
  return name === GENERAL_LIBRARY_NAME;
}
