// Thin wrapper over Voyage AI embeddings, kept behind this interface so the
// provider could be swapped later. Uses voyage-3.5-lite (1024-dim by default).

export const EMBEDDING_MODEL = "voyage-3.5-lite";
const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";

// Voyage accepts up to 1000 inputs per request; we batch conservatively since
// requests also have a total-token cap.
const BATCH_SIZE = 96;

type InputType = "document" | "query";

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function embedBatch(
  texts: string[],
  inputType: InputType,
): Promise<number[][]> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "VOYAGE_API_KEY is not set. Add it to .env.local before embedding.",
    );
  }

  const response = await fetch(VOYAGE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: texts,
      model: EMBEDDING_MODEL,
      input_type: inputType,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Voyage embeddings request failed: ${response.status} ${response.statusText}. ${body.slice(0, 300)}`,
    );
  }

  const json = (await response.json()) as {
    data?: { embedding: number[]; index: number }[];
  };
  const data = json.data ?? [];
  // Sort by index to guarantee the embedding order matches the input order.
  return data
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

// Embed a list of texts. input_type "document" for stored content (default),
// "query" for search queries. Batches transparently.
export async function embedTexts(
  texts: string[],
  inputType: InputType = "document",
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const results: number[][] = [];
  for (const batch of chunk(texts, BATCH_SIZE)) {
    const vectors = await embedBatch(batch, inputType);
    results.push(...vectors);
  }
  return results;
}

// Embed a single search query (input_type "query").
export async function embedQuery(text: string): Promise<number[]> {
  const [vec] = await embedTexts([text], "query");
  return vec;
}
