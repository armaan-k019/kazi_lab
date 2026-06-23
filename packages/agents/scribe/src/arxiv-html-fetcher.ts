import { JSDOM } from "jsdom";
import { fetchWithTimeout } from "./http";
import { htmlToMarkdown, countMarkdownTables } from "./markdown";
import { STORED_TEXT_CAP } from "./types";

// Fetch the arXiv HTML full text (https://arxiv.org/html/{id}, the LaTeXML
// pilot) and convert it to markdown with tables preserved as GFM. Returns null
// when HTML is unavailable (older papers, no TeX source) so the caller falls
// back. The bare id works when HTML exists; no version suffix is needed.
export async function fetchArxivHtmlText(
  arxivId: string,
): Promise<{ markdown: string; tableCount: number } | null> {
  const url = `https://arxiv.org/html/${arxivId}`;
  let res: Response;
  try {
    res = await fetchWithTimeout(url);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const html = await res.text();
  // Guard against an abs/redirect stub being served with 200.
  if (!/ltx_page_main|<article/i.test(html)) return null;

  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;
  const root =
    doc.querySelector("article") ??
    doc.querySelector(".ltx_page_main") ??
    doc.body;
  if (!root) return null;

  // Strip chrome and the bibliography so the text budget goes to content.
  root
    .querySelectorAll(
      ".ltx_bibliography, nav, header, footer, .ltx_page_footer, .ltx_dates, script, style",
    )
    .forEach((el) => el.remove());
  root.querySelectorAll("section").forEach((sec) => {
    const heading =
      sec.querySelector("h1,h2,h3,.ltx_title")?.textContent?.toLowerCase() ?? "";
    if (/^\s*(references|bibliography|acknowledg)/.test(heading)) sec.remove();
  });

  let markdown = htmlToMarkdown(root.innerHTML);
  if (markdown.length > STORED_TEXT_CAP) markdown = markdown.slice(0, STORED_TEXT_CAP);
  if (markdown.replace(/\s/g, "").length < 400) return null; // too thin; treat as unavailable
  return { markdown, tableCount: countMarkdownTables(markdown) };
}
