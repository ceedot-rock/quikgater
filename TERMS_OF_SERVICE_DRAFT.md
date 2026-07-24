# Quikgater Terms of Service — DRAFT, NOT LEGAL ADVICE

**This is a draft written by an AI assistant to satisfy the spec's requirement for published terms, based on the policies already encoded in the codebase (blocklist, robots.txt handling, rate limits, DMCA process). It has not been reviewed by a lawyer and should not be published or relied upon as-is.** Get it reviewed by someone qualified before this goes anywhere near a live URL. Placeholders like `[COMPANY NAME]` need real values; several sections (liability limits, indemnification, dispute resolution/arbitration, governing law) need a lawyer's judgment, not an LLM's.

---

## 1. What Quikgater Is

Quikgater is a pay-per-request API that fetches and renders the text/markdown content of publicly accessible web pages, so that AI agents and automated systems can retrieve web content without operating their own scraping infrastructure. Payment is via the x402 protocol (USDC on Base).

## 2. What Quikgater Will Not Do

Quikgater does not, and will not:

- Fetch content behind a login, paywall, or other access control the requester does not already have legitimate access to.
- Bypass CAPTCHAs, bot-detection, or similar protections on sites that are attempting to authenticate or restrict automated access, except where explicitly reviewed and approved (see §3).
- Fetch from any domain on our blocklist (financial institutions, government login portals, social media platforms, major paywalled news publishers, ticketing platforms — the current list is maintained in the Worker's `blocklist.ts` and an internal, dynamically-updated KV list; both are enforced before any other processing).
- Ignore a site's `robots.txt` by default. Requesters may pass `ignore_robots=true` to bypass this for a specific request; doing so is logged and does not exempt the request from rate limiting or blocklist enforcement.

If a request is blocked for any of the above reasons, no payment is settled — you are not charged for a request Quikgater refuses to serve.

## 3. Higher-Risk Fetching (Layer 3 / Hard Fallback)

Some pages are protected by bot-detection systems (e.g., Cloudflare Turnstile) that are not strictly paywalls, but that actively attempt to distinguish human from automated traffic. Quikgater may, in the future, offer a higher-cost tier that defeats these protections for pages that are otherwise public and non-authenticated. **As of this draft, that capability is disabled pending legal review** — see the codebase's `hardFallback.ts` for the current status. This section will be updated with the actual policy once that review happens; don't assume a specific outcome here.

## 4. Rate Limits

To prevent Quikgater from being used as a denial-of-service tool against third-party sites, requests to any single domain are rate-limited (currently 100 requests/minute per domain per requester at the edge; the render/fetch pipeline may apply additional limits, e.g., against upstream provider rate limits). Requesters who need higher throughput against a specific domain should contact us rather than attempting to work around these limits with multiple accounts or IP rotation — that's a violation of these terms.

## 5. DMCA / Takedown Requests

If you are a rights holder and believe Quikgater has cached or served content you have the right to have removed, submit a takedown request to **[ABUSE/LEGAL CONTACT EMAIL — NOT YET SET]** with:

- The URL(s) in question
- A description of your rights in the content
- Your contact information
- A statement that you have a good-faith belief the use is not authorized

We aim to remove cached copies of the specified content within **1 hour** of receiving a valid request (matching the spec's internal SLA). This does not affect our ability to re-fetch the same URL in the future if it's requested again and still passes our blocklist/robots.txt checks — a takedown removes our cached copy, it doesn't blocklist the domain going forward unless the underlying issue is a blocklist-worthy one.

## 6. Payment, Pricing, and Refunds

- Quikgater charges per request via the x402 protocol (USDC). Current pricing tiers are published at **[PRICING PAGE URL — NOT YET SET]** and may change; the price for a given request is quoted before you sign a payment authorization, and that quoted price is what's charged.
- **If a request fails and produces no content, you are not charged.** Payment is only settled once content is actually delivered (cache hit) or a render actually succeeds.
- Because payments use exact, single-use cryptographic authorizations, there is no automated refund mechanism once a payment settles. If you believe you were charged in error (e.g., for genuinely broken content), contact **[SUPPORT EMAIL — NOT YET SET]**.

## 7. No Warranty on Fetched Content

Quikgater is a pipe, not a publisher. We do not verify, endorse, or take responsibility for the accuracy, legality, or safety of any content it fetches on your behalf. You are responsible for how you use the content you receive.

## 8. Prohibited Uses

You may not use Quikgater to:

- Attempt to access content you don't otherwise have a legitimate right to access.
- Circumvent our blocklist, rate limits, or robots.txt handling through technical workarounds (e.g., disguising blocklisted domains, distributing requests across many accounts to exceed rate limits).
- Use Quikgater as a proxy for activity that would violate the target site's own terms of service in a way that creates legal exposure for us — [NEEDS LEGAL INPUT: how far do we want this to reach, and how enforceable is it].
- Resell access to Quikgater without a separate agreement.

## 9. Service Availability

Quikgater is provided on a best-effort basis. [NEEDS LEGAL/BUSINESS INPUT: any SLA commitments, and standard "as-is, no warranty of uptime" language.]

## 10. Limitation of Liability

[NEEDS LEGAL INPUT — this section is the most standard "boilerplate" of a ToS but also the most important to get right for your actual risk tolerance and entity structure. Do not ship a real limitation-of-liability clause drafted by an AI without review.]

## 11. Governing Law / Dispute Resolution

[NEEDS LEGAL INPUT — depends on where the operating entity is incorporated and what dispute resolution mechanism (courts vs. arbitration) is preferred.]

## 12. Changes to These Terms

We may update these terms; material changes will be posted at **[TERMS URL — NOT YET SET]** with an updated effective date. [NEEDS LEGAL INPUT: notice period, whether continued use constitutes acceptance, etc.]

---

*Last updated: never — this is a draft, not a published document. Effective date, company name, entity structure, and all bracketed placeholders need to be filled in before this is real.*
