// A realistic browser-ish User-Agent: some sites reject default fetch agents.
export const USER_AGENT =
  "Mozilla/5.0 (compatible; kazi-lab/0.1; +https://github.com/armaan-k019/kazi_lab)";

export const FETCH_TIMEOUT_MS = 30_000;

// fetch with an abort-based timeout and a real User-Agent.
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, ...(init.headers ?? {}) },
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Timed out fetching ${url} after ${timeoutMs / 1000}s.`);
    }
    throw new Error(`Could not fetch ${url}: ${(error as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}
