// Layer 3 (spec §4): residential proxy + CAPTCHA/Turnstile-solving,
// implemented via ScraperAPI (providers/scraperapi.ts) - the spec's own
// named example vendor. This was intentionally left throwing until legal
// review happened (see LEGAL_REVIEW_REQUEST_LAYER3.md at the repo root)
// - confirmed clear by the user 2026-07-24.
//
// Scope, unchanged from the original stub's constraint: only ever called
// for public, non-authenticated pages that already passed the Worker's
// blocklist + robots.txt checks (spec §2) - this solves bot challenges to
// render content, not to bypass login/paywall. That distinction is the
// legal basis this layer relies on; don't widen its use beyond that
// without going back through the same review.
import { scrape } from "./providers/scraperapi.js";

export interface HardFallbackResponse {
  markdown: string;
  provider: string;
  costActual: number | null;
  title: string | null;
}

// No spec-mandated figure for Layer 3 (only Layer 2's 15s total is
// specified) - longer than Layer 2 on the judgment call that an
// aggressive bypass attempt (residential proxy + challenge-solving) is
// inherently slower than a normal headless render.
const TOTAL_TIMEOUT_MS = 20_000;

// Defense-in-depth per spec §4 Layer 3: "Gate: Only reachable if Layer 2
// failed AND domain is NOT blocklisted (Worker already checked, but
// double-check defensively and log if Worker bypassed)." The Worker
// (worker/src/blocklist.ts) is the real, primary enforcement point and
// already gates this endpoint from ever being called for a blocked
// domain - this is a deliberately small, loosely-synced mirror of that
// same static HARD_BLOCKLIST (not the dynamic KV list, which this
// separate Fly.io service has no access to). Its purpose is to catch and
// log a Worker bypass, not to be the source of truth - keeping it in
// sync isn't safety-critical the way the Worker's own list is.
const DEFENSIVE_HARD_BLOCKLIST = [
  "linkedin.com",
  "instagram.com",
  "facebook.com",
  "tiktok.com",
  "wsj.com",
  "nytimes.com",
  "ft.com",
  "thetimes.co.uk",
  "economist.com",
  "ticketmaster.com",
  "livenation.com",
  "chase.com",
  "wellsfargo.com",
  "login.gov",
  "irs.gov",
];

function isDefensivelyBlocked(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false; // malformed URL - let the real fetch attempt fail naturally instead of guessing here
  }
  if (hostname.endsWith(".bank") || hostname.endsWith(".banking")) return true;
  return DEFENSIVE_HARD_BLOCKLIST.some((pattern) => hostname === pattern || hostname.endsWith(`.${pattern}`));
}

export async function hardFallback(url: string, reasonLayer2Failed: string): Promise<HardFallbackResponse> {
  if (isDefensivelyBlocked(url)) {
    console.error(JSON.stringify({ event: "hard_fallback_blocklist_bypass_suspected", url, reasonLayer2Failed }));
    throw new Error("BLOCKED_LEGAL_RISK: hard fallback defensive blocklist check tripped - the Worker should never have let this through");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Layer 3 20s timeout exceeded")), TOTAL_TIMEOUT_MS);

  // Audit log per spec §4 Layer 3: "Must have audit log: every call logs
  // url, reason Layer 2 failed, provider, cost." Logged for both outcomes
  // (success and failure), not just success - a failed hard-fallback
  // attempt is exactly the kind of call this audit trail exists to catch.
  try {
    const result = await scrape(url, controller.signal);
    console.log(
      JSON.stringify({
        event: "hard_fallback_call",
        url,
        reasonLayer2Failed,
        provider: result.provider,
        costActual: result.costActual,
        status: "success",
      }),
    );
    return result;
  } catch (e) {
    console.log(
      JSON.stringify({
        event: "hard_fallback_call",
        url,
        reasonLayer2Failed,
        provider: "scraperapi",
        costActual: null,
        status: "failed",
        error: String(e),
      }),
    );
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
