// The special, undeletable catch-all library that holds every paper in the
// corpus. It is presented as a plain "all papers" view, not a synthesizable
// research library, so synthesis and discovery controls are hidden for it.
export const GENERAL_LIBRARY_NAME = "general";

// Centralized check for "is this the general/all-papers library?". Reuse this
// everywhere instead of scattering the "general" string literal.
export function isAllPapersLibrary(
  name: string | null | undefined,
): boolean {
  return name === GENERAL_LIBRARY_NAME;
}
