# Title extraction + cost estimation (scaffold)

**Status:** scaffold landed 2026-08-07 (open Step 2).

## Files
- `worker/src/title.ts` — `titleFromHtml`, `titleFromUrl`, `resolveTitle`
- `worker/src/cost_estimate.ts` — tier prices, atomic conversion, worst-case quote

## Next (not done)
1. Call `resolveTitle({ html, url })` in L1 success path before cache write.
2. Use `estimateWorstCase()` before credits pre-auth; `estimateCharge(tier)` after outcome.
3. Unit tests under `worker/test/title.test.ts` + `cost_estimate.test.ts`.
4. Wire into `index.ts` without changing x402 signature shape.

## COST_TABLE.md
Keep price constants in sync with `TIER_PRICE_USD` here.
