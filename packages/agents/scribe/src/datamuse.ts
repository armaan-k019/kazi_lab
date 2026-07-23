import { fetchWithTimeout } from "./http";

// Datamuse client (https://api.datamuse.com). Lightweight association lookup used
// ONLY to canonicalize/expand concept labels (never to create edges). Keyless,
// optional, and silent: on any failure it returns [] without logging noise.

const TIMEOUT_MS = 10_000;
function base(): string {
  return process.env.DATAMUSE_BASE_URL || "https://api.datamuse.com";
}

// Words most associated with a term ("means like"), highest score first.
export async function datamuseAssociations(term: string, max = 10): Promise<string[]> {
  const q = term.trim();
  if (!q) return [];
  try {
    const res = await fetchWithTimeout(`${base()}/words?ml=${encodeURIComponent(q)}&max=${max}`, {}, TIMEOUT_MS);
    if (!res.ok) return [];
    const json = (await res.json()) as { word?: string }[];
    return json.map((w) => w.word).filter((w): w is string => !!w);
  } catch {
    return [];
  }
}
