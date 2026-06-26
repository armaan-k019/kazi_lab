// The special, undeletable catch-all library that holds every paper in the
// corpus. It is presented as a plain "all papers" view, not a synthesizable
// research library, so synthesis, critique, and cross-domain analysis exclude it.
export const GENERAL_LIBRARY_NAME = "general";

// Centralized check for "is this the general/all-papers library?". Reuse this
// everywhere (web app and agents) instead of scattering the "general" literal.
export function isAllPapersLibrary(
  name: string | null | undefined,
): boolean {
  return name === GENERAL_LIBRARY_NAME;
}
