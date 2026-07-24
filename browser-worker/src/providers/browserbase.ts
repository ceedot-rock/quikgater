// Step 6: Multi-Provider Failover (spec §4 Layer 2, §8 Step 6).
//
// Uses Browserbase's Fetch API (POST /v1/fetch), not the full
// session+CDP+Playwright flow - it's the simplest path to "give me
// markdown for this URL", which is all render() needs. Confirmed against
// https://docs.browserbase.com/features/fetch, not from memory.
export interface RenderResult {
  markdown: string;
  providerUsed: "browserbase";
  // Browserbase's Fetch API response doesn't report a per-call dollar
  // cost - null here is honest, not a placeholder for a real number.
  costActual: number | null;
}

const BROWSERBASE_FETCH_URL = "https://api.browserbase.com/v1/fetch";

interface BrowserbaseFetchResponse {
  statusCode: number;
  content: string;
  contentType: string;
}

export async function render(url: string, signal?: AbortSignal): Promise<RenderResult> {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  if (!apiKey) throw new Error("BROWSERBASE_API_KEY not configured");

  const res = await fetch(BROWSERBASE_FETCH_URL, {
    method: "POST",
    headers: { "X-BB-API-Key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({ url, format: "markdown" }),
    signal,
  });

  if (!res.ok) {
    throw new Error(`browserbase fetch failed: ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as BrowserbaseFetchResponse;
  if (typeof body.content !== "string" || body.content.length === 0) {
    throw new Error("browserbase fetch returned no content");
  }

  return { markdown: body.content, providerUsed: "browserbase", costActual: null };
}
