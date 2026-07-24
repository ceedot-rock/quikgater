// x402 payment gate — Base Sepolia (testnet), scheme "exact" (EIP-3009
// transferWithAuthorization on USDC). Schema and endpoints verified
// directly against github.com/coinbase/x402 specs/x402-specification-v1.md
// and specs/transports-v1/http.md, and confirmed live against the
// facilitator's /supported endpoint before this was written.
//
// Facilitator: https://x402.org/facilitator - the free, no-API-key
// testnet facilitator (Base Sepolia only; do NOT point this at mainnet -
// mainnet requires a CDP-hosted facilitator with API keys, which is a
// deliberately separate decision, not a config flip).

export const FACILITATOR_URL = "https://x402.org/facilitator";
export const NETWORK = "base-sepolia";
export const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const X402_VERSION = 1;

export interface PaymentRequirements {
  scheme: "exact";
  network: string;
  maxAmountRequired: string;
  asset: string;
  payTo: string;
  resource: string;
  description: string;
  mimeType: string;
  outputSchema: null;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string };
}

export interface PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  payload: {
    signature: string;
    authorization: {
      from: string;
      to: string;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: string;
    };
  };
}

interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

interface SettleResponse {
  success: boolean;
  errorReason?: string;
  transaction: string;
  network: string;
  payer: string;
}

// Prices the client must know and sign for *before* we do any work -
// EIP-3009's transferWithAuthorization signs an exact `value`, so
// whatever we quote here is the only amount we can ever settle for this
// Rail A (x402) request. There is no "charge less/more after the fact"
// without a second signature from the client.
//
// CACHE_HIT: $0.0002, matches spec §5's cache tier - known immediately,
// settled synchronously in index.ts.
//
// MISS: $0.08, NOT the spec's $0.002 "standard fetch" rate - still true
// even now that Layer 1 (worker/src/layer1.ts) exists. The price is
// quoted here, before the client signs anything, so it can't yet reflect
// whether Layer 1 will end up handling the request instead of a full
// Layer 2 render - that's only known after payment is verified (see
// layer1.ts for why probing any earlier isn't safe). $0.08 is priced for
// the worst case (a full render, real provider cost $0.01-0.05), so every
// outcome - Layer 1 or Layer 2 - is profitable, not just render attempts.
export const CACHE_HIT_PRICE_ATOMIC = "200"; // $0.0002
export const MISS_PRICE_ATOMIC = "80000"; // $0.08

// Rail B (deposit credits, credits.ts) has no equivalent exact-signature
// constraint - a debit is just an internal KV write, decided *after* the
// real outcome is known, not pre-quoted and signed. That's what finally
// makes real per-tier pricing possible: a Bearer-billed request that
// Layer 1 ends up serving is debited the real $0.002 "standard fetch"
// rate instead of Rail A's worst-case $0.08 (see queue.ts's
// priceAtomicForTier and index.ts's Bearer billing path). Only used by
// credits.ts/queue.ts - Rail A still can never use these for the reason
// above.
export const STANDARD_FETCH_PRICE_ATOMIC = "2000"; // $0.002 - Layer 1 success, credits only
export const HARD_FALLBACK_PRICE_ATOMIC = "10000"; // $0.10 - Layer 3, credits only (L3 itself is still legally gated/stubbed)
export const FAILURE_PRICE_ATOMIC = "100"; // $0.0001 - total failure, credits only; Rail A stays $0 on failure (can't charge without a fresh signature)

/** Maps a cost-log layer to the atomic price a credits-billed job should be debited, now that the real outcome is known. Rail A can't use this - see the constants' comments above. */
export function priceAtomicForTier(layer: "L0" | "L1" | "L2" | "L2-browserbase" | "L2-steel" | "L2-firecrawl" | "L3"): string {
  if (layer === "L0") return CACHE_HIT_PRICE_ATOMIC;
  if (layer === "L1") return STANDARD_FETCH_PRICE_ATOMIC;
  if (layer === "L3") return HARD_FALLBACK_PRICE_ATOMIC;
  return MISS_PRICE_ATOMIC; // L2 and its provider-specific variants
}

/**
 * Builds the PaymentRequirements for a request, priced by whether it's
 * already known to be a cache hit (checked in index.ts *before* this is
 * called, specifically so the quoted price is correct up front).
 */
export function buildPaymentRequirements(opts: {
  resource: string;
  payTo: string;
  cacheHit: boolean;
}): PaymentRequirements {
  return {
    scheme: "exact",
    network: NETWORK,
    maxAmountRequired: opts.cacheHit ? CACHE_HIT_PRICE_ATOMIC : MISS_PRICE_ATOMIC,
    asset: USDC_BASE_SEPOLIA,
    payTo: opts.payTo,
    resource: opts.resource,
    description: opts.cacheHit
      ? "Quikgater cache hit"
      : "Quikgater render attempt (settled only if content is actually delivered)",
    mimeType: "application/json",
    outputSchema: null,
    // 180s, not the original 60s: settlement for a miss is deferred
    // until the async queue consumer resolves the render (worker/src/
    // queue.ts), which has taken 30s+ under a cold Fly machine in this
    // repo's own testing (see README's Step 4 "4x calls" finding). The
    // client's signed authorization must still be valid when we finally
    // call /settle - 60s cut that too close.
    maxTimeoutSeconds: 180,
    extra: { name: "USDC", version: "2" },
  };
}

export function paymentRequiredBody(requirements: PaymentRequirements, error: string) {
  return { x402Version: X402_VERSION, error, accepts: [requirements] };
}

/** Decodes the base64 X-PAYMENT request header per the HTTP transport spec. */
export function decodePaymentHeader(header: string): PaymentPayload | null {
  try {
    return JSON.parse(atob(header));
  } catch {
    return null;
  }
}

/** Encodes a settlement/error object for the X-PAYMENT-RESPONSE header. */
export function encodePaymentResponseHeader(body: unknown): string {
  return btoa(JSON.stringify(body));
}

export async function verifyPayment(
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifyResponse> {
  const res = await fetchImpl(`${FACILITATOR_URL}/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ x402Version: X402_VERSION, paymentPayload, paymentRequirements }),
  });
  if (!res.ok) {
    return { isValid: false, invalidReason: `facilitator_http_${res.status}` };
  }
  return res.json();
}

/**
 * Settles a verified payment (broadcasts the transferWithAuthorization tx).
 *
 * Called from two places: index.ts settles cache hits synchronously
 * (outcome is already known), and queue.ts settles a miss's authorization
 * only if the render actually succeeds - never on RENDER_FAILED. That
 * second part matters: since the exact signed amount can't be reduced
 * after the fact, "charge less on failure" isn't achievable here, so we
 * charge *nothing* on total failure instead (skip calling /settle
 * entirely - the client's authorization just expires unused).
 */
export async function settlePayment(
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
  fetchImpl: typeof fetch = fetch,
): Promise<SettleResponse> {
  const res = await fetchImpl(`${FACILITATOR_URL}/settle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ x402Version: X402_VERSION, paymentPayload, paymentRequirements }),
  });
  if (!res.ok) {
    return {
      success: false,
      errorReason: `facilitator_http_${res.status}`,
      transaction: "",
      network: paymentRequirements.network,
      payer: paymentPayload.payload.authorization.from,
    };
  }
  return res.json();
}
