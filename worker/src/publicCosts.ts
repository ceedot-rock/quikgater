/**
 * Public cost table for Quikgater (cost-estimation scaffolding).
 * Source of truth for numbers: ./payment.ts (and docs/COST_TABLE.md).
 */
import {
  CACHE_HIT_PRICE_ATOMIC,
  MISS_PRICE_ATOMIC,
  STANDARD_FETCH_PRICE_ATOMIC,
  HARD_FALLBACK_PRICE_ATOMIC,
  FAILURE_PRICE_ATOMIC,
  priceAtomicForTier,
  NETWORK,
} from "./payment";

function atomicToUsd(atomic: string): number {
  return Number(atomic) / 1_000_000;
}

/** JSON body for GET /v1/costs */
export function buildPublicCostsBody(): Record<string, unknown> {
  return {
    success: true,
    unit: "atomic",
    atomicPerUsd: 1_000_000,
    network: NETWORK,
    note: "Rail A (x402) quotes hit vs miss before signature; Rail B (credits) debits real tier after outcome.",
    railA_x402: {
      cacheHit: { atomic: CACHE_HIT_PRICE_ATOMIC, usd: atomicToUsd(CACHE_HIT_PRICE_ATOMIC) },
      missRender: { atomic: MISS_PRICE_ATOMIC, usd: atomicToUsd(MISS_PRICE_ATOMIC) },
    },
    railB_credits: {
      L0_cacheHit: { atomic: CACHE_HIT_PRICE_ATOMIC, usd: atomicToUsd(CACHE_HIT_PRICE_ATOMIC) },
      L1_standardFetch: { atomic: STANDARD_FETCH_PRICE_ATOMIC, usd: atomicToUsd(STANDARD_FETCH_PRICE_ATOMIC) },
      L2_fullRender: { atomic: MISS_PRICE_ATOMIC, usd: atomicToUsd(MISS_PRICE_ATOMIC) },
      L3_hardFallback: { atomic: HARD_FALLBACK_PRICE_ATOMIC, usd: atomicToUsd(HARD_FALLBACK_PRICE_ATOMIC) },
      failure: { atomic: FAILURE_PRICE_ATOMIC, usd: atomicToUsd(FAILURE_PRICE_ATOMIC) },
    },
    tiers: {
      L0: priceAtomicForTier("L0"),
      L1: priceAtomicForTier("L1"),
      L2: priceAtomicForTier("L2"),
      L3: priceAtomicForTier("L3"),
    },
    subscription: { product: "Quikgater Pro", usdPerMonth: 29, status: "specced" },
  };
}
