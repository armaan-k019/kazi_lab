// Extract exactly the FIRST complete JSON object from a model response via
// brace-depth matching (string-aware), so trailing prose or a second block after
// a valid object does not break parsing, and a stray formatting slip after the
// object is ignored. If the object never closes (truncated output), returns the
// partial so JSON.parse fails and the caller's truncation branch handles it.
//
// This is the same approach used by the metric extractor. Opus 4.8 occasionally
// emits a formatting slip on large JSON, so both cross-domain calls (synthesis
// and the Critic) parse through this helper.
export function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const body = fenced ? fenced[1].trim() : trimmed;
  const start = body.indexOf("{");
  if (start < 0) return body;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i++) {
    const c = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  return body.slice(start);
}
