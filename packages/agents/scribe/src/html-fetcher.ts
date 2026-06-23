import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { fetchWithTimeout } from "./http";
import { htmlToMarkdown, countMarkdownTables } from "./markdown";
import { STORED_TEXT_CAP, type SourcePaperData } from "./types";

const MIN_USABLE_CHARS = 200;

function visibleLength(s: string): number {
  return s.replace(/\s/g, "").length;
}
function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

export async function fetchHtmlPaper(
  url: string,
  // The router may already have fetched the body while inspecting Content-Type.
  prefetchedHtml?: string,
): Promise<SourcePaperData> {
  let html = prefetchedHtml;
  if (html === undefined) {
    const response = await fetchWithTimeout(url);
    if (!response.ok) {
      throw new Error(
        `Could not fetch page: ${response.status} ${response.statusText}.`,
      );
    }
    html = await response.text();
  }

  let title = "";
  let proseMarkdown = "";

  // Readability for the main prose. Convert its content HTML to markdown so any
  // tables it kept survive as GFM (textContent would flatten them). Readability
  // mutates its DOM, so run it on its own.
  try {
    const dom = new JSDOM(html, { url });
    const article = new Readability(dom.window.document).parse();
    if (article) {
      title = (article.title ?? "").trim();
      if (article.content) proseMarkdown = htmlToMarkdown(article.content);
    }
  } catch {
    // fall through to stripped text below
  }

  // Fallback: stripped text if Readability gave little/nothing.
  if (visibleLength(proseMarkdown) < MIN_USABLE_CHARS) {
    const dom = new JSDOM(html, { url });
    const doc = dom.window.document;
    if (!title) title = (doc.querySelector("title")?.textContent ?? "").trim();
    proseMarkdown = (doc.body?.textContent ?? "").replace(/\s+/g, " ").trim();
  }

  // Recover tables Readability dropped: convert every <table> in the original
  // document to markdown and append any not already present in the prose.
  let tablesMarkdown = "";
  try {
    const dom = new JSDOM(html, { url });
    const proseNorm = normalize(proseMarkdown);
    const seen = new Set<string>();
    dom.window.document.querySelectorAll("table").forEach((tbl) => {
      const md = htmlToMarkdown(tbl.outerHTML).trim();
      const key = normalize(md);
      if (md.length < 8 || seen.has(key)) return;
      seen.add(key);
      if (proseNorm.includes(key.slice(0, 80))) return; // already inline
      tablesMarkdown += `\n\n${md}`;
    });
  } catch {
    // tables are best-effort
  }

  let content = (proseMarkdown + tablesMarkdown).trim();
  if (visibleLength(content) < MIN_USABLE_CHARS) {
    throw new Error(
      "Could not extract readable content from this page (it may be empty, paywalled, or rendered entirely with JavaScript).",
    );
  }
  if (content.length > STORED_TEXT_CAP) content = content.slice(0, STORED_TEXT_CAP);

  return {
    sourceType: "html",
    arxivId: null,
    title: title.slice(0, 300), // hint only; the extractor finalizes metadata
    authors: [],
    abstract: null,
    publishedAt: null,
    url,
    pdfUrl: null,
    rawText: content,
    metadataConfidence: "inferred",
    parsePath: "readability_tables",
    tableCount: countMarkdownTables(content),
  };
}
