// Small display helpers. All run client-side (the corpus is fetched in the
// browser), so timezone-dependent formatting is safe here.

export function formatAuthors(authors: string[]): string {
  if (!authors || authors.length === 0) return "unknown authors";
  if (authors.length <= 3) return authors.join(", ");
  const surname = authors[0].trim().split(/\s+/).pop() ?? authors[0];
  return `${surname} et al. +${authors.length - 1}`;
}

// Published date: just the calendar day, monospace. Null -> em dash.
export function formatPublished(iso: string | null): string {
  if (!iso) return "—";
  return iso.slice(0, 10);
}

// Ingested timestamp: YYYY-MM-DD HH:MM, monospace.
export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}
