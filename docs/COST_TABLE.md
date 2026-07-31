# Quikgater — cost / price table (static)

Source of truth in code: `worker/src/payment.ts` (`CACHE_HIT_PRICE_ATOMIC`, `MISS_PRICE_ATOMIC`, `STANDARD_FETCH_PRICE_ATOMIC`, …).  
**1 atomic unit = $0.000001** (USDC 6 decimals).

Updated: 2026-07-31 · network today: **Base Sepolia** (testnet) for Rail A x402.

## Rail A — x402 (exact signature, quoted before serve)

| Outcome | Atomic | USD | When |
|---------|-------:|----:|------|
| Cache hit (L0) | `200` | **$0.0002** | Known cache hit before quote |
| Miss / render path (L2 default quote) | `80000` | **$0.08** | Worst-case quote when not a known hit |

Notes:

- Rail A **cannot** reprice after Layer 1 vs Layer 2 is known (EIP-3009 signed amount is fixed).
- Miss is priced for full render (~$0.01–0.05 provider cost) so L1 *or* L2 stays profitable under the same quote.
- Failure on Rail A: no settlement / no charge without a fresh signature.

## Rail B — deposit credits (debit after outcome)

| Layer / outcome | Atomic | USD | Notes |
|-----------------|-------:|----:|-------|
| L0 cache hit | `200` | **$0.0002** | Same as Rail A hit |
| L1 standard fetch | `2000` | **$0.002** | Credits-only tiered win vs $0.08 |
| L2 full render (any provider) | `80000` | **$0.08** | browserbase / steel / firecrawl |
| L3 hard fallback | `10000` | **$0.10** | Legally gated / stubbed today |
| Total failure | `100` | **$0.0001** | Credits path only |

Mapping helper: `priceAtomicForTier(layer)` in `payment.ts`.

## Subscription (product, not per-call)

| Product | Price | Status |
|---------|------:|--------|
| Quikgater Pro | **$29/mo** | Specced in README; not built |

## Rough provider cost (ops, not customer quote)

| Provider / path | Typical cost band | Customer quote (Rail A miss) |
|-----------------|------------------:|------------------------------|
| Layer 1 (worker fetch) | ~$0.00001–0.0001 | still $0.08 pre-signed |
| Browserbase / Steel / Firecrawl | ~$0.01–0.05 | $0.08 |
| Cache hit | ~$0 | $0.0002 |

## API price exposure

- `402` payment requirements use `maxAmountRequired` = hit or miss atomic string.
- Response cost logs: `cost_actual_usd` via `costlog.ts` (ops telemetry; often `null` from providers).

Do not invent lower public prices than this table without updating `payment.ts` and re-verifying facilitator flows.
