/**
 * Cost estimation scaffolding (Step 2 — open tasks).
 * Aligns with docs/COST_TABLE.md and credits.ts atomic units (1 unit = $0.000001).
 * Pure functions for quoting before charge / after tier resolution.
 */

export type FetchTier = "cache" | "L0" | "L1" | "L2" | "L3";

/** Spec-ish USD list prices per successful fact (editable). */
export const TIER_PRICE_USD: Record<FetchTier, number> = {
  cache: 0.0002,
  L0: 0.0005,
  L1: 0.001,
  L2: 0.005,
  L3: 0.02,
};

/** Rough provider cost floors (ops, not charge). */
export const TIER_COST_USD: Record<FetchTier, number> = {
  cache: 0.00001,
  L0: 0.00002,
  L1: 0.0001,
  L2: 0.002,
  L3: 0.01,
};

export function usdToAtomic(usd: number): number {
  return Math.max(0, Math.round(usd * 1_000_000));
}

export function atomicToUsd(atomic: number): number {
  return atomic / 1_000_000;
}

export function estimateCharge(tier: FetchTier): {
  tier: FetchTier;
  charge_usd: number;
  charge_atomic: number;
  cost_usd: number;
  margin_usd: number;
} {
  const charge_usd = TIER_PRICE_USD[tier];
  const cost_usd = TIER_COST_USD[tier];
  return {
    tier,
    charge_usd,
    charge_atomic: usdToAtomic(charge_usd),
    cost_usd,
    margin_usd: Math.max(0, charge_usd - cost_usd),
  };
}

/** Worst-case quote before fetch (affordability gate). */
export function estimateWorstCase(opts?: { allowBrowser?: boolean }): {
  max_charge_usd: number;
  max_charge_atomic: number;
  tier: FetchTier;
} {
  const tier: FetchTier = opts?.allowBrowser === false ? "L2" : "L3";
  const e = estimateCharge(tier);
  return {
    max_charge_usd: e.charge_usd,
    max_charge_atomic: e.charge_atomic,
    tier,
  };
}

export function estimateFromBytes(bytes: number): FetchTier {
  // crude: larger / complex pages tend toward deeper tiers
  if (bytes <= 0) return "L0";
  if (bytes < 50_000) return "L1";
  if (bytes < 500_000) return "L2";
  return "L3";
}
