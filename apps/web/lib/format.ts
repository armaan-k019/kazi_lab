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

// Relative time like "just now", "5 minutes ago", "2 hours ago". Client-only.
export function formatRelativeTime(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
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
