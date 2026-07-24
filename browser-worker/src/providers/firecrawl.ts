// Step 6: Multi-Provider Failover (spec §4 Layer 2, §8 Step 6).
//
// Firecrawl's POST /v2/scrape endpoint (v2, not v1 - confirmed against
// current docs.firecrawl.dev/api-reference/endpoint/scrape, which
// superseded v1). Bearer auth, "formats" (plural) as an array.
export interface RenderResult {
  markdown: string;
  providerUsed: "firecrawl";
  // Firecrawl's scrape response doesn't include a per-call dollar-cost
  // field (credit usage is tracked account-side, not per-response) -
  // null here is honest, not a placeholder for a real number.
  costActual: number | null;
}

const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape";

interface FirecrawlScrapeResponse {
  success: boolean;
  data?: { markdown?: string };
}

export async function scrape(url: string, signal?: AbortSignal): Promise<RenderResult> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) throw new Error("FIRECRAWL_API_KEY not configured");

  const res = await fetch(FIRECRAWL_SCRAPE_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ url, formats: ["markdown"] }),
    signal,
  });

  if (!res.ok) {
    throw new Error(`firecrawl scrape failed: ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as FirecrawlScrapeResponse;
  if (!body.success || !body.data?.markdown) {
    throw new Error("firecrawl scrape returned no markdown content");
  }

  return { markdown: body.data.markdown, providerUsed: "firecrawl", costActual: null };
}
