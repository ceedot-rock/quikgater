# Fetchgate

Pay-per-fact web fetch for AI agents. Implementation of `fetchgate_v2_1_FINAL.md` (x402 Primitive Spec v2.1), which is the source of truth for architecture/pricing/policy decisions - this README only tracks build status.

## Layout

- `worker/` — `fetchgate-worker`, the Cloudflare Worker edge layer (blocklist, robots.txt, rate limit, eventually the x402/cache/queue gate).
- `browser-worker/` — `fetchgate-browser-worker`, the Fly.io render service (Layers 2-3: rented render failover, hard fallback).

## Build order status (spec §8)

| Step | What | Status |
|---|---|---|
| 1 | Edge Safety — blocklist KV + robots.txt check in the Worker | **Done.** `worker/src/{blocklist,robots,ratelimit}.ts` + `index.ts`. 30 tests passing (`cd worker && npm test`), incl. payment-gate tests. |
| 2 | Delete Toxic Code — strip v1's paywall-bypass code from the Fly.io repo | **N/A.** This is a from-scratch build, not a migration of an existing v1 repo — there's nothing to delete. If you're pointing this at an already-deployed v1 `fetchgate-browser-worker` (formerly `tollbooth-browser-worker`), run the `grep -r "archive.is" .` check from the spec there before reusing that deployment. |
| 3 | Split Routes — `POST /render` (failover) + `POST /hard-fallback`, proxy logic only in the second route | **Done** (routing + orchestration shape). `browser-worker/src/index.ts` dispatches both routes; `render.ts` has the failover-orchestrator structure from the spec's pseudocode. Both routes currently fail because the providers they call are Step 6 stubs — that's expected until Step 6. |
| 4 | Async Queue — Worker pushes to Cloudflare Queue instead of calling Fly.io synchronously | **Done.** Real Cloudflare Queue (`fetchgate-render-queue`), producer + consumer both wired in `worker/src/{queue,index}.ts`. Worker returns `202` + `jobId` instead of calling Fly.io synchronously; consumer calls `/render` then `/hard-fallback` on failure; `GET /v1/job/{id}` polls status. See caveat below. |
| 5 | Cache + Cost Tracking — KV/R2 dedup cache (Layer 0) + Tinybird logging | **Done.** Real KV (metadata) + R2 (body) cache in `worker/src/cache.ts`, wired into `index.ts` (hit short-circuits before the queue) and `queue.ts` (successful renders populate it). Cost tracking is real structured logging matching spec §6's exact schema (`worker/src/costlog.ts`) - not real Tinybird yet, no token available. See caveats below. |
| 6 | Multi-Provider Failover — Browserbase primary, Steel.dev + Firecrawl fallbacks | **Done, live-verified with real content delivered.** Real HTTP clients in `browser-worker/src/providers/{browserbase,steeldev,firecrawl}.ts` against each provider's actual current API (endpoints/auth/schemas pulled from their live docs and SDK source, not memory). `render.ts` enforces the spec's 15s total timeout across the failover chain via a shared `AbortController`. Real (paid) API keys for all three are set as Fly secrets. 16/16 tests passing. See "Live" below for the full end-to-end proof. |

**Payment gate (not one of the spec's numbered steps, but now built):** `worker/src/payment.ts`, wired into `index.ts` ahead of the Step 1 blocklist check, matching spec §3's architecture diagram order. x402 protocol, scheme `exact`, network `base-sepolia` (testnet — see "Going to mainnet" below), verified live against the real `x402.org/facilitator` (schema pulled directly from `github.com/coinbase/x402/specs`, not from memory). Do not reuse `/home/cee/projects/x402-client` — that's an unrelated Solana payer client, and Fetchgate is the payment *verifier*, not a payer.

**Payment-verify rate limit:** `checkPaymentVerifyRateLimit` in `worker/src/ratelimit.ts`, 300 req/min per requester, checked immediately before the facilitator `/verify` call (not after — the point is to bound that outbound network call itself, not just the HTTP response). Deliberately keyed on requester only, not requester+domain like the Step 1 domain limiter — otherwise rotating target domains would dodge it entirely while still hammering the facilitator. 300 (not something tighter) because every request needs its own verification with no session caching, so a legitimate client near the domain limiter's 100/min ceiling - or spread across a few domains - needs real headroom above 100.

**Queue caveat:** the spec reserves the queue for requests that miss Layer 0 (cache, Step 5) *and* fail Layer 1 (a cheap in-Worker fetch attempt — not built, and not one of the 6 numbered steps either). Neither exists, so right now **every** request that clears the Step 1 shield goes straight to the queue - there's no cheaper layer in front of it to skip first. That's more expensive per-request than the spec's real design; it's a consequence of what's built so far, not a bug in the queue wiring itself.

**Cache caveats, stated plainly:**
- **TTL classification is a URL-shape heuristic**, not real content classification (`classifyTtl` in `cache.ts`) - it has no signal from the page itself. Matches the spec's own "start with static map" framing; needs real hit-rate data to tune, not more guessing.
- **No ETag/If-None-Match revalidation.** The spec calls for revalidating on TTL expiry rather than a hard cache-miss; that needs the render pipeline to accept and return conditional-request headers, which `browser-worker`'s `/render` doesn't support (Step 6 gap, not this layer's).
- **R2 bodies can outlive their KV pointer.** KV's own TTL expiry is what makes an entry invisible to `getCached`, but the R2 object isn't cleaned up when that happens - an orphan, not a bug, until something sweeps it (R2 lifecycle rule, or a job keyed off KV expiry events).
- **No title extraction.** `browser-worker` doesn't parse HTML into a real title (Step 6 gap) - `deriveTitle()` falls back to the first Markdown heading, then the URL itself.

**Settlement is now wired and live** (see "Live" below for the real on-chain proof). Two real architectural constraints shaped the design, worth understanding before touching this code:

- **EIP-3009 signs an exact amount - there's no "charge less/more after the fact."** The client's signature is cryptographically bound to a specific `value`; you cannot settle a different amount than what was signed without a fresh signature. This means the price **must** be quoted correctly *before* the client signs, not decided afterward.
- **Cache lookup moved to before the payment gate** (`index.ts`) specifically so the quoted price is correct: cache hit → `$0.0002`, miss → `$0.08`. It's a read-only lookup, so there's no leak in checking it pre-payment - nothing is served until after payment clears.
- **Miss price is $0.08, not the spec's $0.002 "standard fetch" rate** - because Layer 1 (free in-Worker fetch) isn't built, every miss is actually a full render attempt. Pricing it at $0.002 would mean losing money on every successful render (real cost $0.01-0.05 vs a $0.002 charge) - the same margin bug caught and fixed earlier for Step 5's cost table, now correctly reflected in what's actually charged.
- **Cache hits settle synchronously; misses settle only if the render succeeds - never on total failure.** For a hit, the outcome is already known, so it settles right in `index.ts`. For a miss, settlement is deferred into the queue consumer (`queue.ts`), which only calls `settlePayment` after a provider actually delivers content. If every provider and hard-fallback fail, `settlePayment` is never called at all - the client's signed authorization simply expires unused. That's the only clean way to do "don't charge for nothing" under EIP-3009's exact-amount model; there's no partial-settle or refund primitive to lean on instead.
- **`maxTimeoutSeconds` raised from 60 to 180** to give the deferred-miss path enough runway - queue processing has taken 30s+ under a cold Fly machine in this repo's own testing, and the client's authorization must still be valid when `/settle` finally gets called.
- **Settlement failure despite a successful render is a real edge case, not swallowed.** If `/settle` fails after content was already rendered (expired authorization, facilitator error), the content is still returned - it was already produced, withholding it doesn't get anyone paid - but the job status carries `settled: false` and `settlementError` so the gap is visible, not hidden.

**Still not implemented:**
- **Bearer/deposit-credits rail** (spec §5 Rail B — Stripe deposits, auto-topup). This is also the *only* way to cleanly support real outcome-based tiered pricing (charging $0.08 vs $0.10 vs a partial-failure fee) - under Rail A's exact-payment model, that would require a fresh signature per outcome, which isn't how EIP-3009 async flows work in practice. Rail B debits an internal balance instead, sidestepping the signature problem entirely. Worth knowing this isn't just unbuilt - it's the actual missing piece for true dynamic pricing, not a nice-to-have.
- **Free tier.** Spec's "100 free cache hits/day/IP" needs an account/IP-quota system that doesn't exist - a cache hit is cheap to serve (no queue, no Fly.io call) but still requires a valid payment, same as a miss.

**Step 6 caveats, stated plainly:**
- **No `costActual` from any provider, confirmed on real calls, not just from reading docs.** The live test below returned `"costActual":null` from a real successful Browserbase call - checked each provider's response schema beforehand (Browserbase Fetch, Steel `/v1/scrape`, Firecrawl `/v2/scrape`) and none report a per-call dollar cost in the body, and the real response confirmed it. Spec §6's `cost_actual_usd` will stay `null` for L2 until/unless a provider exposes this (or costs get estimated from published pricing instead of measured per-call).
- **No title extraction.** None of the three providers return a distinct page title separate from the markdown body in the shapes used here - `deriveTitle()` (Step 5, `cache.ts`) still falls back to the first Markdown heading, then the URL.
- **API keys are real Fly secrets, not in `fly.toml`.** Set via `fly secrets set`; one (`FIRECRAWL_API_KEY`) came from a "session-specific auth" block in a pasted CLI onboarding document rather than a dashboard-generated key, and may be short-lived/scoped to that session - worth regenerating from the Firecrawl dashboard if it stops working later.

## Before Step 6's Layer 3 in particular

`browser-worker/src/hardFallback.ts` (Layer 3, residential proxy + CAPTCHA/Turnstile-solving) is intentionally left throwing. The spec's §4 Layer 3 section now has an explicit scope note: this is flagged for legal review before GA, because automated challenge-solving carries different ToS risk than passive fetching even on non-paywalled content. Get that review before implementing a real provider here, not after. This is separate from Step 6 (Layer 2) above, which has no such gate.

## Running things

```bash
cd worker && npm install && npm test              # 75 tests
cd worker && npx wrangler dev --local --port 8788  # live local server, real facilitator calls
cd browser-worker && npm install && npm test       # 16 tests
cd browser-worker && npm run dev                   # server on :8080, 502s without provider API keys
```

`worker/wrangler.toml`'s `PAY_TO_ADDRESS` is the Ethereum burn address (`0x000...dEaD`) — a deliberate, clearly-labeled local/test fixture, not a placeholder pretending to be real. It's fine for `npm test` and `wrangler dev`. It is **not** fine to deploy.

## Live

**`fetchgate-worker` is deployed and serving traffic: https://fetchgate-worker.ceedotrock.workers.dev**

Smoke-tested against the real URL after deploy (not just `wrangler dev`): no-payment → real 402 with `payTo` correctly showing the production address, malformed `X-PAYMENT` → 400, missing `url` param → 400. Cloudflare account: `63705eb783d1e108f0d599661c56b05e` (workers.dev subdomain `ceedotrock` was auto-registered via the API as part of this deploy — accounts don't have one by default). All 4 KV namespaces are real, `wrangler.toml` has zero `REPLACE_WITH_REAL_KV_ID` placeholders left.

Reminder of what "live" meant *at this point in the build*: the payment gate verified real x402 payment authorizations against the real Base Sepolia facilitator, but never settled them - no USDC moved yet, by design, until there was a real resource behind Steps 4-6 to charge for. That's no longer true as of the settlement work below - see "Real settlement fired on-chain" for what changed.

**`fetchgate-browser-worker` is also deployed: https://fetchgate-browser-worker.fly.dev** (Fly.io, app `fetchgate-browser-worker`, org "personal", region `iad`, single machine, `min_machines_running = 1`). Originally smoke-tested with `/render` correctly 502ing (Step 6 was stubbed then); see below for the real-provider re-test once Step 6 landed. `POST /hard-fallback` still correctly 502s `HARD_FALLBACK_FAILED` (blocked on the Layer 3 legal review above, unaffected by Step 6), missing-`url` → 400, unknown route → 404.

**Full pipeline fired for real, end to end, 2026-07-24.** A throwaway EVM keypair (`0x0c095a7C3716aebeC895d36B2DDd1D0c610c8588`, logged in `.env_secrets` as `X402_TEST_WALLET_*`, testnet-only, zero real value) was funded with 20 USDC on Base Sepolia via the CAPTCHA-gated public faucet, then used to sign a real EIP-712 `TransferWithAuthorization` and fire it at the live Worker with a real `X-PAYMENT` header. Confirmed:

1. The real `x402.org/facilitator` verified the signature and returned the correct payer address.
2. `fetchgate-worker` returned `202` with a real `jobId` and enqueued onto the real `fetchgate-render-queue`.
3. The queue consumer picked it up and called `fetchgate-browser-worker`'s `/render` - confirmed independently via `fly logs`, which show `browserbase`/`steeldev`/`firecrawl` all failing with `NOT_IMPLEMENTED` (Step 6 stubs) at the moment the payment was fired.
4. `GET /v1/job/{id}` correctly resolved to `{"status":"failed","error":"RENDER_FAILED"}`.
5. No settlement occurred (confirmed via the `payment.settled: false` in the response) - consistent with the design, not a gap.

**One real finding from this test, not a fabricated caveat:** `fly logs` shows `/render` was hit **four times**, not once, all within about 30 seconds. `browser-worker`'s `fly.toml` had `auto_stop_machines = true` / `min_machines_running = 0` at the time, so the machine was very likely asleep when the first request arrived; a cold-start-induced connection failure would make `processRenderJob` throw, which makes `queue()` call `message.retry()` (up to `max_retries = 3` in `wrangler.toml`) - 1 initial attempt + 3 retries matches the 4 observed calls exactly. Plausible, not 100% certain from the logs alone.

**`min_machines_running` set to 1** (2026-07-24) to address this - but with a real caveat, not a clean fix: **this Fly org is on the free trial plan**, and Fly's own runtime logs from the prior deploy explicitly said `Trial machine stopping. To run for longer than 5m0s, add a credit card`. Trial machines get force-stopped after 5 minutes regardless of `min_machines_running`, so this setting won't fully eliminate cold starts until a card is added at fly.io/trial (a decision only the account owner can make - not done here). Left as-is deliberately: the queue's retry-on-failure already handles a cold machine correctly (confirmed by the very test that found this), just at the cost of up to 4x calls/latency on a cold hit rather than 1x.

**Step 5 (cache) deployed and live-tested for real, 2026-07-24.** Creating the R2 bucket hit a genuine Cloudflare-side bug first (`[code: 10042] Please enable R2 through the Cloudflare Dashboard` even with R2 already active/subscribed - a known, [publicly reported](https://github.com/cloudflare/workers-sdk/issues/2877) backend entitlement-propagation glitch, not a token/config issue on our end). It cleared on retry. Once the real bucket existed: seeded a real R2 object + KV metadata entry via `wrangler r2 object put` / `wrangler kv key put` for a test URL, then reused the same funded testnet wallet from the Step 4 test to fire another real signed x402 payment at that exact URL. Result: `200` immediately, with the exact pre-seeded markdown, `cacheHit: true`, correct `tierUsed`, no job enqueued, no settlement - the live cache-hit short-circuit works end to end with real payment verification in front of it, not just against local tests.

The cache-miss path was already proven live by the Step 4 test itself (nothing was cached then, so that whole test *was* the miss path) - no need to re-spend testnet funds proving it twice.

**Step 6 fired for real, end to end, 2026-07-24 - the first time this entire build has actually delivered real content, not just resolved to `failed`.** Real `BROWSERBASE_API_KEY` / `STEEL_API_KEY` / `FIRECRAWL_API_KEY` set as Fly secrets, `browser-worker` redeployed. Two-stage proof:

1. **Direct `/render` test** (no payment, no queue - just the provider integration): `POST /render {"url":"https://example.com"}` → real 200 with real markdown, `providerUsed: "browserbase"` (primary succeeded, no failover needed).
2. **Full pipeline via a real signed x402 payment** (reusing the same funded testnet wallet from Steps 4/5, for a fresh uncached URL): payment verified → `202` + `jobId` → queue consumer called `browser-worker` → Browserbase succeeded → `GET /v1/job/{id}` resolved to `"status":"done"` with the real markdown, `providerUsed: "browserbase"`. Then fired a **second** real payment for the *same* URL: `200` immediately, `cacheHit: true`, `tierUsed: "L2-browserbase"` - proving Steps 4, 5, and 6 all work together for real, not just individually.

Both calls' `costActual` came back `null` from the real API, confirming the "no per-call cost data" caveat above against reality, not just documentation. No settlement occurred either time (`payment.settled: false`) - Fetchgate can now deliver real paid-provider content without charging for it, which is still the deliberate boundary described above, just a sharper version of it now that there's something real behind it.

**Real settlement fired on-chain, 2026-07-24 - the first time actual money has moved anywhere in this build.** Reused the same funded testnet wallet (still had ~20 USDC left). Two settlements, both verified three ways: the job/response JSON, the wallet's on-chain balance before/after, and the transaction itself on a public block explorer.

1. **Miss → real render → deferred settlement.** Signed and fired a $0.08 (80000 atomic units) authorization for a fresh URL. `202` → queued → `browserbase` rendered it for real → `GET /v1/job/{id}` resolved to `"settled": true` with a real transaction hash. Wallet balance dropped from **20.00 → 19.92 USDC** - exactly $0.08. Looked up the tx hash on Base Sepolia Blockscout: `result: "success"`, 42 confirmations, broadcast by the real facilitator's relayer address, raw calldata decoding to exactly `80000` atomic units from our wallet to `PAY_TO_ADDRESS`. Not just "the API said so" - independently confirmed on a public explorer.
2. **Same URL, second payment → cache hit → synchronous settlement at the correct, cheaper price.** Signed a $0.0002 (200 atomic units) authorization this time - the price index.ts actually quotes for cache hits. `200` immediately, `cacheHit: true`, `settled: true`, real transaction hash. Wallet balance dropped from **19.92 → 19.9198 USDC** - exactly $0.0002, proving the pre-payment cache lookup correctly picks the cheaper price rather than always charging the render rate.

Nothing was charged for nothing: the earlier Step 4 test (before settlement existed) resolved to `RENDER_FAILED` and correctly never touched a wallet at all - that behavior is unchanged now that settlement exists, since failure still skips `settlePayment` entirely.

**`PAY_TO_ADDRESS` changed and re-verified live, 2026-07-24.** Updated in `worker/wrangler.toml` from `0x8542B90d11a5c21722a4A3B1047098a82203e288` to `0x64E31E05583F250644b76d0FFe12e129ea4DeeCe`. All 75 tests still passed after the change; redeployed, then smoke-tested the live `402` response until `payTo` reflected the new address (took a few seconds - Worker deploys aren't instant-everywhere).

Then fired a real end-to-end payment against the new address, reusing the same funded testnet wallet: signed a $0.08 (80000 atomic units) `TransferWithAuthorization` for a fresh, guaranteed-uncached URL. `202` → queued → `browserbase` rendered it for real → `GET /v1/job/{id}` resolved to `"status":"done"`, `"settled":true`, with a real transaction hash. Independently confirmed on Base Sepolia Blockscout (not just the job JSON): the transaction's token-transfer log shows exactly `80000` units (6 decimals = $0.08) moving from the test wallet (`0x0c095a7C...c8588`) to `0x64E31E05583F250644b76d0FFe12e129ea4DeeCe` - the new address is correctly live and receiving settled payments.

## Going to mainnet (separate decision, not a config flip)

Switching `network` from `base-sepolia` to `base` and pointing at a real facilitator (CDP-hosted, needs an API key) means real USDC moves. Do this deliberately, after Layer 3's legal review (see above) and after Steps 4-6 exist so payments are actually settled against real delivered content — not before.
