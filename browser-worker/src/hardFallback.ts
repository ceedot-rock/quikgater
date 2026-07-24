// Layer 3 (spec §4): residential proxy + CAPTCHA/Turnstile-solving. Not
// numbered as one of the 6 MVP build steps, so left as a stub here - but
// NOT a step to fill in casually. Per the scope note added to the spec
// (§4 Layer 3): this must stay gated to public, non-authenticated pages
// that already passed the Step 1 blocklist + robots.txt checks, and is
// flagged for legal review before GA - automated challenge-solving
// carries different ToS risk than passive fetching, even on non-paywalled
// content. Don't wire a real provider in here without that review having
// happened.
export interface HardFallbackResponse {
  markdown: string;
  provider: string;
  costActual: number;
}

export async function hardFallback(_url: string, _reasonLayer2Failed: string): Promise<HardFallbackResponse> {
  throw new Error("NOT_IMPLEMENTED: hard fallback (residential proxy / CAPTCHA solving) - blocked on legal review, see spec §4 Layer 3");
}
