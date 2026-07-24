# Legal Review Request: Layer 3 "Hard Fallback" — DRAFT, NOT LEGAL ADVICE

**This document was drafted by an AI assistant to help scope a legal review, based on the technical design already in the codebase. It is not legal advice, has not been reviewed by a lawyer, and should not be relied on as a risk assessment in itself — it exists to give counsel a concrete starting point instead of a blank page.** Send this to counsel before implementing anything in `browser-worker/src/hardFallback.ts`, which is currently a stub that throws `NOT_IMPLEMENTED` specifically so this can't happen by accident.

## 1. What Quikgater does today (already built, not part of this review)

Quikgater is a pay-per-request API (x402 / USDC on Base) that fetches and renders the content of public web pages on behalf of AI agents. Layers already implemented:

- **Layer 0 (cache):** serves previously-fetched content from our own storage.
- **Layer 1:** not yet built (planned: a cheap in-Worker fetch before any rendering).
- **Layer 2 (render):** calls third-party rendering APIs (Browserbase, Steel.dev, Firecrawl) that load the page like a normal browser and return its content. No credential use, no login, no bot-detection bypass — if a site blocks these providers' normal traffic, the request simply fails.

All of this is already gated by:
- A hard + dynamic **blocklist** (financial institutions, login portals, social platforms, paywalled news, ticketing — checked before anything else).
- **robots.txt compliance by default** (a requester can pass `ignore_robots=true` for a single request, which is logged; this does not affect what's being asked about below).
- **Domain-level rate limiting** (100 req/min/domain/requester) to bound load placed on any third-party site.
- No payment is settled for a blocked/disallowed request.

**None of the above is what's being asked about here.** This review is scoped narrowly to Layer 3.

## 2. What Layer 3 would add (the thing that needs review)

Layer 3 ("hard fallback") is invoked only when Layer 2 fails — i.e., a page's bot-detection (e.g., Cloudflare Turnstile, other CAPTCHA systems) blocked the ordinary rendering attempt. The planned implementation would use a **residential proxy** (to present as an ordinary consumer IP rather than a datacenter/bot IP) and **automated CAPTCHA/challenge-solving** to get past that detection and retrieve the page content anyway.

Scope constraints already decided at the design level (not up for debate in this review, stated so counsel knows the boundaries):
- Only ever invoked for URLs that already passed the Layer 1 blocklist and robots.txt checks — i.e., pages that are not on our list of known-sensitive domains and whose robots.txt (if respected for that request) doesn't disallow the path.
- Only ever attempted on pages that are otherwise publicly accessible without login — this is explicitly **not** a paywall- or authentication-bypass feature.
- Same domain-level rate limiting applies.

## 3. Why this is flagged as a different risk category than Layers 0-2

Layers 0-2 fail closed: if a site's bot-detection blocks the request, we simply return an error to the requester. Layer 3 is specifically the feature that would **not** fail closed in that case — its entire purpose is to defeat a site's active attempt to distinguish human from automated traffic. That is a meaningfully different act than a normal `fetch()` or a rendering service loading a page the way a real browser would, even though the *content being retrieved* is identical to what Layer 2 already handles.

Non-exhaustive list of legal questions this raises, for counsel to assess (not the AI's conclusions — deliberately unresolved here):

- **Computer Fraud and Abuse Act (CFAA) / state computer-crime analogs.** Does deliberately defeating a technical access-control measure (even on non-authenticated, non-paywalled content) risk "access without authorization" exposure, given case law like *hiQ Labs v. LinkedIn* and *Van Buren v. United States* has trended toward requiring an actual authorization barrier (not just a ToS violation) — and could CAPTCHA/Turnstile count as exactly that barrier?
- **DMCA anti-circumvention (17 U.S.C. § 1201).** Is a CAPTCHA/bot-challenge an "effective technological measure" controlling access to a copyrighted work for purposes of this statute? This is separate from the DMCA takedown process already documented in `TERMS_OF_SERVICE_DRAFT.md` §5, which handles a different scenario (removal after the fact, not the legality of automated retrieval itself).
- **Breach of contract via Terms of Service.** Many sites' ToS explicitly prohibit automated access / bot traffic. Does routing around bot-detection to serve a paying customer create contract-based exposure distinct from the criminal-statute questions above, and does it matter that the *requester* (not Quikgater) is the one who ultimately wants the content?
- **Trespass to chattels / similar tort theories.** Historically raised in scraping litigation (e.g., early *eBay v. Bidder's Edge*-era cases) — likely less live today post-*hiQ*, but worth counsel's judgment on current relevance.
- **Vicarious/facilitation exposure.** Quikgater would be the one performing the circumvention, on behalf of a third-party requester, for a fee. Does operating this as a paid intermediary change or increase exposure relative to an individual doing the same thing for themselves?
- **Jurisdictional variance.** The above is US-centric (CFAA, DMCA); Quikgater's requesters and the sites being fetched could be anywhere. Worth flagging whether a narrower initial rollout (e.g., US-sites-only, or explicitly excluding certain jurisdictions/site categories) reduces exposure meaningfully.

## 4. Business context counsel may want

- Revenue model: requests are priced per-fetch via x402 (currently $0.08/render on testnet); a Layer 3 tier would presumably be priced higher given the added cost/risk, but pricing hasn't been decided and isn't gated on this review.
- Current deployment is **testnet only** (Base Sepolia, no real funds). Going to mainnet (real USDC) is already gated on this Layer 3 review per the project's own README — i.e., the business has already decided not to take real payments until this is resolved, independent of whether Layer 3 itself ships.
- No Layer 3 provider (proxy or CAPTCHA-solving vendor) has been selected or contracted yet — this review is meant to happen *before* that vendor selection, not after.

## 5. What we need from this review

1. A go/no-go on building Layer 3 at all, or conditions under which it would be acceptable (e.g., specific site categories excluded, specific jurisdictions excluded, specific proxy/solving vendors preferred or excluded based on their own ToS/practices).
2. If "go": what disclosures need to change in `TERMS_OF_SERVICE_DRAFT.md` §3 (which currently just says this is disabled pending review, with no committed policy).
3. Whether the requester (the party who ultimately receives the content) needs to make any representation or agreement about their own use, given they're the one asking for a specific blocked page.

Until this comes back, `hardFallback.ts` stays a stub that throws — that's an intentional, load-bearing gate in the code, not a placeholder to fill in opportunistically.
