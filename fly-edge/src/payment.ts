/** Fly-edge subset of worker/src/payment.ts — mock SettleHop + public costs only. */
export const NETWORK = "base-sepolia";

export const CACHE_HIT_PRICE_ATOMIC = "200";
export const MISS_PRICE_ATOMIC = "80000";
export const STANDARD_FETCH_PRICE_ATOMIC = "2000";
export const HARD_FALLBACK_PRICE_ATOMIC = "10000";
export const FAILURE_PRICE_ATOMIC = "100";

export interface PaymentRequirements {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra?: Record<string, unknown>;
}

export function buildPaymentRequirements(opts: {
  resource: string;
  cacheHit?: boolean;
  description?: string;
  payTo?: string;
}): PaymentRequirements {
  return {
    scheme: "exact",
    network: NETWORK,
    maxAmountRequired: opts.cacheHit ? CACHE_HIT_PRICE_ATOMIC : MISS_PRICE_ATOMIC,
    resource: opts.resource,
    description: opts.description || "Quikgater SettleHop",
    mimeType: "application/json",
    payTo: opts.payTo || "0xAd3dB8e2b1A311701E6233f17F6d648e4A52287c",
    maxTimeoutSeconds: 180,
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  };
}

export function priceAtomicForTier(
  layer: "L0" | "L1" | "L2" | "L2-browserbase" | "L2-steel" | "L2-firecrawl" | "L3",
): string {
  if (layer === "L0") return CACHE_HIT_PRICE_ATOMIC;
  if (layer === "L1") return STANDARD_FETCH_PRICE_ATOMIC;
  if (layer === "L3") return HARD_FALLBACK_PRICE_ATOMIC;
  return MISS_PRICE_ATOMIC;
}

export function mockSettleHopReceipt(hopId: string) {
  return {
    success: true,
    transaction: `mock-settlehop-${hopId || "unknown"}`,
    network: NETWORK,
    payer: "0x0000000000000000000000000000000000000000",
  };
}
