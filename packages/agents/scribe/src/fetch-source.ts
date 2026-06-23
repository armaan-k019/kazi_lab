import { fetchArxivPaper, isArxivInput } from "./arxiv-fetcher";
import { fetchPdfPaper } from "./pdf-fetcher";
import { fetchHtmlPaper } from "./html-fetcher";
import { fetchWithTimeout } from "./http";
import type { FetchOptions, SourcePaperData } from "./types";

// Add a scheme if the user pasted a bare host/path, then validate.
function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    return new URL(withScheme).toString();
  } catch {
    throw new Error(`"${input}" is not a valid URL.`);
  }
}

function hasPdfExtension(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}

// Detect the source type from a URL (or raw arXiv id) and dispatch to the right
// handler. Every handler returns the uniform SourcePaperData shape.
export async function fetchSource(
  url: string,
  opts: FetchOptions = {},
): Promise<SourcePaperData> {
  // arXiv: highest-quality path. Now prefers HTML full text (tables as markdown)
  // with vision/pdf/abstract fallbacks inside fetchArxivPaper.
  if (isArxivInput(url)) {
    return fetchArxivPaper(url, opts);
  }

  const normalized = normalizeUrl(url);

  // Fast path: an explicit .pdf URL.
  if (hasPdfExtension(normalized)) {
    return fetchPdfPaper(normalized, undefined, opts);
  }

  // Otherwise fetch once and route on the Content-Type, passing the payload
  // through so the handler doesn't fetch again.
  const response = await fetchWithTimeout(normalized);
  if (!response.ok) {
    throw new Error(
      `Could not fetch ${normalized}: ${response.status} ${response.statusText}.`,
    );
  }
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();

  if (contentType.includes("application/pdf")) {
    return fetchPdfPaper(normalized, await response.arrayBuffer(), opts);
  }
  if (
    contentType.includes("text/html") ||
    contentType.includes("application/xhtml") ||
    contentType === ""
  ) {
    return fetchHtmlPaper(normalized, await response.text());
  }

  throw new Error(
    `Unsupported content type: ${contentType || "unknown"}. Provide an arXiv link, a PDF, or an HTML article.`,
  );
}
