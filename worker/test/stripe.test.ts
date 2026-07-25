import { describe, expect, it, vi } from "vitest";
import {
  createDepositCheckoutSession,
  createProSubscriptionCheckoutSession,
  expireCheckoutSession,
  isValidDepositAmount,
  parseCheckoutCompletedEvent,
  parseSubscriptionCheckoutCompletedEvent,
  parseSubscriptionStatusEvent,
  verifyWebhookSignature,
} from "../src/stripe";
import type { Env } from "../src/env";

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function fakeStripeSignatureHeader(secret: string, rawBody: string, timestamp = Math.floor(Date.now() / 1000)): Promise<string> {
  const v1 = await hmacHex(secret, `${timestamp}.${rawBody}`);
  return `t=${timestamp},v1=${v1}`;
}

describe("isValidDepositAmount", () => {
  it("accepts the three spec-defined amounts", () => {
    expect(isValidDepositAmount(5)).toBe(true);
    expect(isValidDepositAmount(20)).toBe(true);
    expect(isValidDepositAmount(100)).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isValidDepositAmount(10)).toBe(false);
    expect(isValidDepositAmount(0)).toBe(false);
    expect(isValidDepositAmount(-5)).toBe(false);
  });
});

describe("verifyWebhookSignature", () => {
  const secret = "whsec_test_secret";
  const rawBody = JSON.stringify({ id: "evt_test", type: "checkout.session.completed" });

  it("accepts a correctly signed payload", async () => {
    const header = await fakeStripeSignatureHeader(secret, rawBody);
    expect(await verifyWebhookSignature(rawBody, header, secret)).toBe(true);
  });

  it("rejects a payload signed with the wrong secret", async () => {
    const header = await fakeStripeSignatureHeader("whsec_wrong_secret", rawBody);
    expect(await verifyWebhookSignature(rawBody, header, secret)).toBe(false);
  });

  it("rejects a tampered body that doesn't match the signature", async () => {
    const header = await fakeStripeSignatureHeader(secret, rawBody);
    const tamperedBody = JSON.stringify({ id: "evt_test", type: "checkout.session.completed", extra: "injected" });
    expect(await verifyWebhookSignature(tamperedBody, header, secret)).toBe(false);
  });

  it("rejects a stale timestamp outside the tolerance window", async () => {
    const staleTimestamp = Math.floor(Date.now() / 1000) - 10 * 60; // 10 minutes old
    const header = await fakeStripeSignatureHeader(secret, rawBody, staleTimestamp);
    expect(await verifyWebhookSignature(rawBody, header, secret)).toBe(false);
  });

  it("rejects a malformed signature header", async () => {
    expect(await verifyWebhookSignature(rawBody, "not-a-real-header", secret)).toBe(false);
    expect(await verifyWebhookSignature(rawBody, "", secret)).toBe(false);
  });
});

describe("parseCheckoutCompletedEvent", () => {
  it("extracts apiKey and amount from a real-shaped checkout.session.completed event", () => {
    const event = {
      type: "checkout.session.completed",
      data: { object: { mode: "payment", metadata: { apiKey: "qg_abc123" }, amount_total: 500 } },
    };
    expect(parseCheckoutCompletedEvent(event)).toEqual({ apiKey: "qg_abc123", amountTotalCents: 500 });
  });

  it("returns null for any other event type", () => {
    const event = { type: "payment_intent.succeeded", data: { object: {} } };
    expect(parseCheckoutCompletedEvent(event)).toBeNull();
  });

  it("returns null when metadata.apiKey is missing", () => {
    const event = {
      type: "checkout.session.completed",
      data: { object: { mode: "payment", metadata: {}, amount_total: 500 } },
    };
    expect(parseCheckoutCompletedEvent(event)).toBeNull();
  });

  it("returns null when amount_total is missing", () => {
    const event = {
      type: "checkout.session.completed",
      data: { object: { mode: "payment", metadata: { apiKey: "qg_abc" } } },
    };
    expect(parseCheckoutCompletedEvent(event)).toBeNull();
  });

  it("returns null for a subscription-mode session, even with matching fields - that's a Pro checkout, not a deposit", () => {
    const event = {
      type: "checkout.session.completed",
      data: { object: { mode: "subscription", metadata: { apiKey: "qg_abc" }, amount_total: 2900 } },
    };
    expect(parseCheckoutCompletedEvent(event)).toBeNull();
  });
});

describe("createDepositCheckoutSession", () => {
  it("posts the right shape to Stripe's API and returns the session url/id", async () => {
    const fakeEnv = { STRIPE_SECRET_KEY: "rk_test_fake" } as Env;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.stripe.com/v1/checkout/sessions");
      expect(init?.headers).toMatchObject({ authorization: `Basic ${btoa("rk_test_fake:")}` });
      const body = new URLSearchParams(init?.body as string);
      expect(body.get("mode")).toBe("payment");
      expect(body.get("line_items[0][price_data][unit_amount]")).toBe("2000");
      expect(body.get("metadata[apiKey]")).toBe("qg_test");
      return new Response(JSON.stringify({ id: "cs_test_123", url: "https://checkout.stripe.com/cs_test_123" }), { status: 200 });
    });

    const result = await createDepositCheckoutSession(
      fakeEnv,
      { amountUsd: 20, apiKey: "qg_test", successUrl: "https://example.com/success", cancelUrl: "https://example.com/cancel" },
      fetchImpl as unknown as typeof fetch,
    );

    expect(result).toEqual({ id: "cs_test_123", url: "https://checkout.stripe.com/cs_test_123" });
  });

  it("throws with the Stripe error body when the API call fails", async () => {
    const fakeEnv = { STRIPE_SECRET_KEY: "rk_test_fake" } as Env;
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 }));

    await expect(
      createDepositCheckoutSession(
        fakeEnv,
        { amountUsd: 5, apiKey: "qg_test", successUrl: "https://example.com/success", cancelUrl: "https://example.com/cancel" },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/Stripe API error \(400\)/);
  });
});

describe("expireCheckoutSession", () => {
  it("posts to the expire endpoint for the given session id", async () => {
    const fakeEnv = { STRIPE_SECRET_KEY: "rk_test_fake" } as Env;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://api.stripe.com/v1/checkout/sessions/cs_test_123/expire");
      return new Response(JSON.stringify({ id: "cs_test_123", status: "expired" }), { status: 200 });
    });
    await expireCheckoutSession(fakeEnv, "cs_test_123", fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("createProSubscriptionCheckoutSession", () => {
  it("posts a real subscription-mode Checkout Session with metadata on both the session and the subscription", async () => {
    const fakeEnv = { STRIPE_SECRET_KEY: "rk_test_fake" } as Env;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.stripe.com/v1/checkout/sessions");
      const body = new URLSearchParams(init?.body as string);
      expect(body.get("mode")).toBe("subscription");
      expect(body.get("line_items[0][price_data][unit_amount]")).toBe("2900");
      expect(body.get("line_items[0][price_data][recurring][interval]")).toBe("month");
      expect(body.get("metadata[apiKey]")).toBe("qg_test");
      expect(body.get("subscription_data[metadata][apiKey]")).toBe("qg_test");
      return new Response(JSON.stringify({ id: "cs_sub_123", url: "https://checkout.stripe.com/cs_sub_123" }), { status: 200 });
    });

    const result = await createProSubscriptionCheckoutSession(
      fakeEnv,
      { apiKey: "qg_test", successUrl: "https://example.com/success", cancelUrl: "https://example.com/cancel" },
      fetchImpl as unknown as typeof fetch,
    );

    expect(result).toEqual({ id: "cs_sub_123", url: "https://checkout.stripe.com/cs_sub_123" });
  });
});

describe("parseSubscriptionCheckoutCompletedEvent", () => {
  it("extracts apiKey and subscriptionId from a real-shaped subscription checkout completion", () => {
    const event = {
      type: "checkout.session.completed",
      data: { object: { mode: "subscription", metadata: { apiKey: "qg_abc" }, subscription: "sub_123" } },
    };
    expect(parseSubscriptionCheckoutCompletedEvent(event)).toEqual({ apiKey: "qg_abc", subscriptionId: "sub_123" });
  });

  it("returns null for a payment-mode session (that's a Rail B deposit, not Pro)", () => {
    const event = {
      type: "checkout.session.completed",
      data: { object: { mode: "payment", metadata: { apiKey: "qg_abc" }, amount_total: 500 } },
    };
    expect(parseSubscriptionCheckoutCompletedEvent(event)).toBeNull();
  });

  it("returns null when subscription id is missing", () => {
    const event = {
      type: "checkout.session.completed",
      data: { object: { mode: "subscription", metadata: { apiKey: "qg_abc" } } },
    };
    expect(parseSubscriptionCheckoutCompletedEvent(event)).toBeNull();
  });
});

describe("parseSubscriptionStatusEvent", () => {
  it("treats an active subscription.updated event as Pro-active", () => {
    const event = {
      type: "customer.subscription.updated",
      data: { object: { id: "sub_123", status: "active", metadata: { apiKey: "qg_abc" } } },
    };
    expect(parseSubscriptionStatusEvent(event)).toEqual({ apiKey: "qg_abc", subscriptionId: "sub_123", active: true });
  });

  it("treats a past_due subscription.updated event as Pro-inactive", () => {
    const event = {
      type: "customer.subscription.updated",
      data: { object: { id: "sub_123", status: "past_due", metadata: { apiKey: "qg_abc" } } },
    };
    expect(parseSubscriptionStatusEvent(event)).toEqual({ apiKey: "qg_abc", subscriptionId: "sub_123", active: false });
  });

  it("treats subscription.deleted as Pro-inactive regardless of the status field", () => {
    const event = {
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_123", status: "canceled", metadata: { apiKey: "qg_abc" } } },
    };
    expect(parseSubscriptionStatusEvent(event)).toEqual({ apiKey: "qg_abc", subscriptionId: "sub_123", active: false });
  });

  it("returns null for unrelated event types", () => {
    const event = { type: "invoice.paid", data: { object: { id: "sub_123", status: "active" } } };
    expect(parseSubscriptionStatusEvent(event)).toBeNull();
  });

  it("returns null when metadata.apiKey is missing", () => {
    const event = {
      type: "customer.subscription.updated",
      data: { object: { id: "sub_123", status: "active", metadata: {} } },
    };
    expect(parseSubscriptionStatusEvent(event)).toBeNull();
  });
});
