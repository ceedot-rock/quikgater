import type { Env } from "./env";

// Rail B (spec §5): Stripe deposit checkout. Uses Stripe-hosted Checkout
// Sessions rather than handling card data ourselves - this Worker has no
// PCI-compliant card handling and shouldn't try to build one.
//
// STRIPE_SECRET_KEY here is a real, LIVE-mode restricted key on an
// account shared with other unrelated projects (see env.ts) - real API
// calls, not a sandbox. Creating a Checkout Session does not charge
// anything by itself; a charge only happens if someone actually completes
// checkout with a real card. Deliberately no code path in this repo
// completes a checkout automatically.
const STRIPE_API_BASE = "https://api.stripe.com/v1";
const ALLOWED_DEPOSIT_AMOUNTS_USD = [5, 20, 100] as const;
export type DepositAmountUsd = (typeof ALLOWED_DEPOSIT_AMOUNTS_USD)[number];

export function isValidDepositAmount(amount: number): amount is DepositAmountUsd {
  return (ALLOWED_DEPOSIT_AMOUNTS_USD as readonly number[]).includes(amount);
}

export interface CheckoutSessionResult {
  id: string;
  url: string;
}

async function stripeRequest(
  env: Env,
  path: string,
  params: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams(params);
  const res = await fetchImpl(`${STRIPE_API_BASE}${path}`, {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`${env.STRIPE_SECRET_KEY}:`)}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`Stripe API error (${res.status}): ${JSON.stringify(json)}`);
  }
  return json;
}

/**
 * Creates a real Stripe Checkout Session for a one-time deposit. `apiKey`
 * is carried in metadata so the webhook handler (below) knows which
 * account to credit once the session actually completes - the account
 * itself must already exist (see index.ts's /v1/credits/checkout route,
 * which creates it up front for a brand-new user before this is called).
 */
export async function createDepositCheckoutSession(
  env: Env,
  opts: { amountUsd: DepositAmountUsd; apiKey: string; successUrl: string; cancelUrl: string },
  fetchImpl: typeof fetch = fetch,
): Promise<CheckoutSessionResult> {
  const json = await stripeRequest(
    env,
    "/checkout/sessions",
    {
      mode: "payment",
      success_url: opts.successUrl,
      cancel_url: opts.cancelUrl,
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": String(opts.amountUsd * 100),
      "line_items[0][price_data][product_data][name]": `Quikgater credits ($${opts.amountUsd})`,
      "metadata[apiKey]": opts.apiKey,
    },
    fetchImpl,
  );
  return { id: json.id as string, url: json.url as string };
}

/** Only used to clean up a Checkout Session created purely to verify the API call itself worked - see the "Live" section of README for that test. Never called as part of the real deposit flow. */
export async function expireCheckoutSession(env: Env, sessionId: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  await stripeRequest(env, `/checkout/sessions/${sessionId}/expire`, {}, fetchImpl);
}

// Quikgater Pro ($29/mo): a real recurring Stripe subscription, not a
// one-time deposit. `mode: "subscription"` instead of Rail B's
// `mode: "payment"`. `apiKey` metadata is set on BOTH the Checkout Session
// itself (so the initial checkout.session.completed event can activate Pro
// immediately) AND on subscription_data (so the Subscription object this
// session creates carries the same metadata forward) - the ongoing
// customer.subscription.updated/deleted lifecycle events reference the
// Subscription, not the original Checkout Session, and have no other way
// to know which account they belong to.
const PRO_MONTHLY_PRICE_USD = 29;

export async function createProSubscriptionCheckoutSession(
  env: Env,
  opts: { apiKey: string; successUrl: string; cancelUrl: string },
  fetchImpl: typeof fetch = fetch,
): Promise<CheckoutSessionResult> {
  const json = await stripeRequest(
    env,
    "/checkout/sessions",
    {
      mode: "subscription",
      success_url: opts.successUrl,
      cancel_url: opts.cancelUrl,
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][recurring][interval]": "month",
      "line_items[0][price_data][unit_amount]": String(PRO_MONTHLY_PRICE_USD * 100),
      "line_items[0][price_data][product_data][name]": "Quikgater Pro (monthly)",
      "metadata[apiKey]": opts.apiKey,
      "subscription_data[metadata][apiKey]": opts.apiKey,
    },
    fetchImpl,
  );
  return { id: json.id as string, url: json.url as string };
}

export interface SubscriptionCheckoutCompletedEvent {
  apiKey: string;
  subscriptionId: string;
}

/**
 * Parses the initial `checkout.session.completed` event for a Pro
 * subscription checkout specifically (`session.mode === "subscription"`) -
 * distinct from parseCheckoutCompletedEvent above, which only fires for
 * `mode === "payment"` (Rail B deposits). The same event *type* covers both
 * products; `mode` is what tells them apart.
 */
export function parseSubscriptionCheckoutCompletedEvent(
  eventBody: Record<string, unknown>,
): SubscriptionCheckoutCompletedEvent | null {
  if (eventBody.type !== "checkout.session.completed") return null;
  const data = eventBody.data as { object?: Record<string, unknown> } | undefined;
  const session = data?.object;
  if (!session || session.mode !== "subscription") return null;
  const metadata = session.metadata as Record<string, string> | undefined;
  const apiKey = metadata?.apiKey;
  const subscriptionId = session.subscription as string | undefined;
  if (!apiKey || !subscriptionId) return null;
  return { apiKey, subscriptionId };
}

export interface SubscriptionStatusEvent {
  apiKey: string;
  subscriptionId: string;
  active: boolean;
}

// Stripe subscription statuses that mean "still paying, keep Pro on" -
// trialing included even though this product has no trial configured,
// since it's a real status Stripe can send and treating it as active is
// the correct default if a trial is ever added later. Everything else
// (past_due, unpaid, incomplete, incomplete_expired, canceled) turns Pro
// off - a lapsed/failed payment should not keep Pro perks active.
const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing"]);

/**
 * Parses the ongoing subscription lifecycle events -
 * customer.subscription.updated (status changes: payment failure ->
 * past_due, cancellation scheduled, reactivation, etc.) and
 * customer.subscription.deleted (the subscription is gone for good, e.g.
 * after Stripe's dunning retries are exhausted). Both reference the
 * Subscription object directly, so `subscription.metadata.apiKey` (set at
 * checkout time above) is what ties this back to a Quikgater account.
 */
export function parseSubscriptionStatusEvent(eventBody: Record<string, unknown>): SubscriptionStatusEvent | null {
  const type = eventBody.type as string | undefined;
  if (type !== "customer.subscription.updated" && type !== "customer.subscription.deleted") return null;

  const data = eventBody.data as { object?: Record<string, unknown> } | undefined;
  const subscription = data?.object;
  if (!subscription) return null;

  const metadata = subscription.metadata as Record<string, string> | undefined;
  const apiKey = metadata?.apiKey;
  const subscriptionId = subscription.id as string | undefined;
  if (!apiKey || !subscriptionId) return null;

  const active = type === "customer.subscription.deleted" ? false : ACTIVE_SUBSCRIPTION_STATUSES.has(subscription.status as string);
  return { apiKey, subscriptionId, active };
}

const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Verifies a real Stripe webhook signature per Stripe's documented scheme
 * (`Stripe-Signature: t=<timestamp>,v1=<hex hmac>`), computed over
 * `${timestamp}.${rawBody}` with the endpoint's signing secret. Rejects
 * stale signatures outside a 5-minute tolerance window to bound replay.
 * Uses Web Crypto (crypto.subtle), not Node's `crypto` module - no new
 * dependency, and consistent with how cache.ts already hashes via
 * crypto.subtle.digest.
 */
export async function verifyWebhookSignature(rawBody: string, signatureHeader: string, secret: string): Promise<boolean> {
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((part) => {
      const [key, value] = part.split("=");
      return [key, value];
    }),
  );
  const timestamp = parts.t;
  const v1 = parts.v1;
  if (!timestamp || !v1) return false;

  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > WEBHOOK_TOLERANCE_SECONDS) return false;

  const expected = await hmacSha256Hex(secret, `${timestamp}.${rawBody}`);
  return timingSafeEqual(expected, v1);
}

export interface CheckoutCompletedEvent {
  apiKey: string;
  amountTotalCents: number;
}

/**
 * Parses a `checkout.session.completed` event body into what credits.ts
 * needs - just the metadata apiKey and the amount actually paid. Only for
 * `mode === "payment"` (Rail B deposits) - the same event type also fires
 * for a completed Pro subscription checkout (`mode === "subscription"`),
 * which parseSubscriptionCheckoutCompletedEvent below handles instead;
 * checking mode here keeps a subscription checkout from being
 * misread as a one-time deposit.
 */
export function parseCheckoutCompletedEvent(eventBody: Record<string, unknown>): CheckoutCompletedEvent | null {
  if (eventBody.type !== "checkout.session.completed") return null;
  const data = eventBody.data as { object?: Record<string, unknown> } | undefined;
  const session = data?.object;
  if (!session || session.mode !== "payment") return null;
  const metadata = session.metadata as Record<string, string> | undefined;
  const apiKey = metadata?.apiKey;
  const amountTotalCents = session.amount_total as number | undefined;
  if (!apiKey || typeof amountTotalCents !== "number") return null;
  return { apiKey, amountTotalCents };
}
