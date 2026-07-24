// Layer 1 (spec §4): a cheap in-Worker fetch attempt, tried before falling
// back to the paid Layer 2 render pipeline (queue -> browser-worker). Just
// a raw HTTP GET + lightweight HTML stripping - no JS execution, no
// headless browser - so it only works for pages that render their real
// content server-side. Falls through to Layer 2 for anything that looks
// like a JS-shell SPA or an active bot challenge (Turnstile, "just a
// moment...", etc.) rather than serving garbage back to the client.
//
// Deliberately attempted only AFTER payment is verified and Step 1 (Edge
// Safety) has passed - same reasoning as Layer 2: an unauthenticated,
// unpaid request must never cause Quikgater to make an arbitrary
// third-party fetch on someone else's behalf for free (see index.ts's
// payment-verify rate limiter for why that concern already shapes this
// codebase). That does mean a client can't get the cheaper $0.002
// "standard fetch" price up front for a page Layer 1 turns out to handle -
// the x402 price is quoted before this ever runs, and EIP-3009's
// exact-signed-amount can't be reduced after the fact (see payment.ts).
// Passing the savings through to the client would need either a
// pre-payment probe (which reopens exactly the free-fetch-for-anyone
// problem this ordering avoids) or Rail B deposit credits (debit the real
// cost after settling at a provisional rate) - neither exists yet. What
// this DOES deliver now: real provider costs (Browserbase/Steel/Firecrawl)
// are skipped entirely whenever a page doesn't need real rendering, and
// the response comes back synchronously instead of via the async queue.
const FETCH_TIMEOUT_MS = 5000; // short - this is supposed to be the *cheap* layer
const MIN_CONTENT_LENGTH = 200; // below this, assume a JS-shell SPA with no server-rendered content

// Checked against the raw HTML, not the stripped text: these are widget
// class/element names that only ever appear inside a tag's attributes
// (e.g. <div class="cf-turnstile">), so tag-stripping would remove them
// from the extracted text entirely before a check against the text could
// ever see them.
const CHALLENGE_HTML_MARKERS = ["cf-turnstile", "g-recaptcha", "h-captcha"];

// Checked against the extracted, visible text. Deliberately full phrases,
// not bare words like "captcha" - a real article *about* Cloudflare or
// bot-mitigation will legitimately use that word many times (caught live
// against en.wikipedia.org/wiki/Cloudflare, which mentions CAPTCHA/
// Turnstile as its actual subject matter - a single-word marker flagged
// it as a "challenge page" when it's exactly the kind of real content
// Layer 1 exists to serve). Full phrases like these are what an actual
// challenge page shows the user, not what an article discussing the
// concept would say.
const CHALLENGE_TEXT_MARKERS = [
  "checking your browser",
  "just a moment",
  "verify you are human",
  "enable javascript to continue",
  "attention required! | cloudflare",
];

export interface Layer1Result {
  markdown: string;
  title: string;
}

/**
 * No HTML parser dependency (none exists in this project) - regex-based
 * tag stripping is good enough for "is there real text here", which is
 * all Layer 1 needs to decide. Not meant to produce publication-quality
 * markdown the way a real renderer would.
 */
function stripHtml(html: string): { title: string; text: string } {
  const withoutScriptsAndStyles = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  const decode = (s: string) =>
    s
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");

  const titleMatch = withoutScriptsAndStyles.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = decode(titleMatch?.[1]?.trim() ?? "");

  const text = decode(withoutScriptsAndStyles.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());

  return { title, text };
}

export async function tryLayer1Fetch(url: string, fetchImpl: typeof fetch = fetch): Promise<Layer1Result | null> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { "user-agent": "quikgater-bot (+https://quikgater.com/bot)" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return null; // network error, timeout, DNS failure, etc. - fall through to Layer 2
  }

  if (!res.ok) return null;

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
    return null; // not renderable as text (e.g. a JSON API response, a binary file)
  }

  const html = await res.text();
  const lowerHtml = html.toLowerCase();
  if (CHALLENGE_HTML_MARKERS.some((marker) => lowerHtml.includes(marker))) return null; // bot-challenge widget present

  const { title, text } = stripHtml(html);

  if (text.length < MIN_CONTENT_LENGTH) return null; // likely a JS-shell SPA with an empty server-rendered body

  const lowerText = text.toLowerCase();
  if (CHALLENGE_TEXT_MARKERS.some((marker) => lowerText.includes(marker))) return null; // active bot challenge, not real content

  return { markdown: title ? `# ${title}\n\n${text}` : text, title: title || url };
}
