import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

// HTML to GitHub-flavored markdown, with the GFM plugin so <table> becomes a
// pipe table (columns/rows/values preserved) rather than being dropped. Used by
// the arXiv-HTML and HTML-article parse paths.
export function htmlToMarkdown(html: string): string {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    hr: "---",
  });
  td.use(gfm);
  // Drop noise that adds no research value and wastes the text budget.
  td.remove(["script", "style", "noscript"]);
  return td.turndown(html).replace(/\n{3,}/g, "\n\n").trim();
}

// Postgres text columns cannot store NUL, and pdf-parse output often contains
// it (plus stray C0 control chars). Strip them; keep tab/newline/CR. Built from
// char codes to avoid embedding literal control characters in the source.
const CONTROL_CHARS = new RegExp(
  "[" +
    "\\u0000-\\u0008" + // before tab
    "\\u000B\\u000C" + // vertical tab, form feed (keep \n=0A, \r=0D)
    "\\u000E-\\u001F" + // after CR
    "]",
  "g",
);
export function sanitizeText(s: string): string {
  return s.replace(CONTROL_CHARS, "");
}

// Count GFM tables in a markdown string by its delimiter rows (e.g. "| --- |").
export function countMarkdownTables(md: string): number {
  let n = 0;
  for (const line of md.split("\n")) {
    const t = line.trim();
    if (/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?$/.test(t)) n++;
  }
  return n;
}
