import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { fetchWithTimeout } from "./http";
import { RAW_TEXT_CAP, type SourcePaperData } from "./types";

const MIN_USABLE_CHARS = 200;

function visibleLength(s: string): number {
  return s.replace(/\s/g, "").length;
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
  let content = "";

  // Readability mutates the document it parses, so run it on its own DOM.
  try {
    const dom = new JSDOM(html, { url });
    const article = new Readability(dom.window.document).parse();
    if (article) {
      title = (article.title ?? "").trim();
      content = (article.textContent ?? "").replace(/[ \t]+\n/g, "\n").trim();
    }
  } catch {
    // fall through to basic extraction below
  }

  // Fallback: strip tags from a fresh DOM if Readability gave little/nothing.
  if (visibleLength(content) < MIN_USABLE_CHARS) {
    const dom = new JSDOM(html, { url });
    const doc = dom.window.document;
    if (!title) title = (doc.querySelector("title")?.textContent ?? "").trim();
    content = (doc.body?.textContent ?? "").replace(/\s+/g, " ").trim();
  }

  if (visibleLength(content) < MIN_USABLE_CHARS) {
    throw new Error(
      "Could not extract readable content from this page (it may be empty, paywalled, or rendered entirely with JavaScript).",
    );
  }

  // Cap to control token cost; the extractor infers metadata from this text.
  const rawText = content.slice(0, RAW_TEXT_CAP);

  return {
    sourceType: "html",
    arxivId: null,
    title: title.slice(0, 300), // hint only; the extractor finalizes metadata
    authors: [],
    abstract: null,
    publishedAt: null,
    url,
    pdfUrl: null,
    rawText,
    metadataConfidence: "inferred",
  };
}
