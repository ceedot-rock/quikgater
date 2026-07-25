// Layer 3 (spec §4): ScraperAPI - residential/premium proxy + automatic
// Cloudflare/Turnstile/Datadome bypass, the spec's own named example
// vendor for hard fallback ("Keep existing proxy + CAPTCHA code, OR swap
// to ScraperAPI residential"). Endpoint/params confirmed against
// ScraperAPI's current docs (docs.scraperapi.com), not memory.
import TurndownService from "turndown";

const SCRAPERAPI_BASE_URL = "https://api.scraperapi.com";
// atx (# Heading), not turndown's default setext (Heading\n===) - the
// Worker's deriveTitle() (worker/src/cache.ts) only recognizes ATX-style
// headings when picking a title for the cache; setext output would
// silently fall back to the raw URL as the title for every Layer 3 result.
const turndown = new TurndownService({ headingStyle: "atx" });

export interface ScraperApiResult {
  markdown: string;
  provider: "scraperapi";
  costActual: number | null;
}

/**
 * Single sync request against ScraperAPI - `render=true` for JS
 * execution, `ultra_premium=true` for the most aggressive residential
 * proxy + bot-bypass tier (their highest cost tier, appropriate here:
 * this only ever runs after Layer 2 already failed, so it's the
 * deliberate expensive last resort, not the default path).
 *
 * Response is raw HTML - ScraperAPI's plain scrape endpoint has no
 * native markdown output the way Browserbase/Steel/Firecrawl do -
 * converted via turndown, the only new dependency this file needed.
 */
export async function scrape(url: string, signal?: AbortSignal): Promise<ScraperApiResult> {
  const apiKey = process.env.SCRAPERAPI_KEY;
  if (!apiKey) throw new Error("SCRAPERAPI_KEY not configured");

  const requestUrl = new URL(SCRAPERAPI_BASE_URL);
  requestUrl.searchParams.set("api_key", apiKey);
  requestUrl.searchParams.set("url", url);
  requestUrl.searchParams.set("render", "true");
  requestUrl.searchParams.set("ultra_premium", "true");

  const res = await fetch(requestUrl.toString(), { signal });
  if (!res.ok) {
    throw new Error(`scraperapi request failed: ${res.status} ${await res.text()}`);
  }

  const html = await res.text();
  const markdown = turndown.turndown(html);

  // sa-credit-cost (response header) is in ScraperAPI credits, not USD -
  // ScraperAPI doesn't publish a fixed credits-to-dollars rate in the
  // response itself (depends on the account's plan tier), so converting
  // this to a real per-call dollar figure here would be a guess dressed
  // up as a number. costActual stays null, same honesty as the other
  // three providers (see browserbase.ts/steeldev.ts/firecrawl.ts).
  return { markdown, provider: "scraperapi", costActual: null };
}
