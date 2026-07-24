// Step 6: Multi-Provider Failover (spec §4 Layer 2, §8 Step 6).
//
// Steel's POST /v1/scrape endpoint. Request/response shape confirmed
// against the real steel-python SDK's generated types
// (client_scrape_params.py / scrape_response.py in steel-dev/steel-python
// on GitHub), not from memory - the JSON field names below match those
// exactly (camelCase, "format" as an array).
export interface RenderResult {
  markdown: string;
  providerUsed: "steeldev";
  // Steel's scrape response has no per-call dollar-cost field - null
  // here is honest, not a placeholder for a real number.
  costActual: number | null;
}

const STEEL_SCRAPE_URL = "https://api.steel.dev/v1/scrape";

interface SteelScrapeResponse {
  content: { markdown?: string };
}

export async function render(url: string, signal?: AbortSignal): Promise<RenderResult> {
  const apiKey = process.env.STEEL_API_KEY;
  if (!apiKey) throw new Error("STEEL_API_KEY not configured");

  const res = await fetch(STEEL_SCRAPE_URL, {
    method: "POST",
    headers: { "steel-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({ url, format: ["markdown"] }),
    signal,
  });

  if (!res.ok) {
    throw new Error(`steel.dev scrape failed: ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as SteelScrapeResponse;
  if (!body.content?.markdown) {
    throw new Error("steel.dev scrape returned no markdown content");
  }

  return { markdown: body.content.markdown, providerUsed: "steeldev", costActual: null };
}
