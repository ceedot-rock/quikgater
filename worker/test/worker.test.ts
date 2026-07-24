import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

// verifyPayment talks to the real x402.org testnet facilitator, which
// needs a genuinely signed EIP-712 authorization to return isValid:true -
// not something a unit test can produce without a real private key. Mock
// it here so Step 1 tests (which aren't about payment verification) don't
// depend on network calls; the dedicated "payment gate" tests below
// override this per-case to test the real decision logic in index.ts.
// settlePayment is mocked too, for the same reason - a real call would
// hit the real facilitator with a fake signature and either error or hang.
vi.mock("../src/payment", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/payment")>();
  return {
    ...actual,
    verifyPayment: vi.fn(async () => ({ isValid: true, payer: "0xTestPayer" })),
    settlePayment: vi.fn(async () => ({
      success: true,
      transaction: "0xMockTransactionHash",
      network: "base-sepolia",
      payer: "0xTestPayer",
    })),
  };
});

// Miniflare's local queue simulator delivers messages to the consumer
// asynchronously in the background, which corrupts test-to-test storage
// isolation when dozens of fetch()-handler tests each enqueue a real
// message in quick succession (observed: "Isolated storage failed").
// enqueueRenderJob/processRenderJob get their own real, unmocked coverage
// in test/queue.test.ts - here we only care that index.ts calls them
// correctly, so mock both and keep getJobStatus real for the polling tests.
let nextJobId = 0;
vi.mock("../src/queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/queue")>();
  return {
    ...actual,
    enqueueRenderJob: vi.fn(async () => ({ jobId: `mock-job-${nextJobId++}` })),
    processRenderJob: vi.fn(async () => undefined),
  };
});

// Layer 1 does a real outbound fetch to the target URL - mocked here for
// the same reason payment/queue are: unit tests shouldn't depend on real
// network calls. Defaults to null (Layer 1 "fails") so every existing
// cache-miss test keeps falling through to the queue exactly as before
// Layer 1 existed; tests that care about the Layer 1 success path
// override this per-case.
vi.mock("../src/layer1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/layer1")>();
  return {
    ...actual,
    tryLayer1Fetch: vi.fn(async () => null),
  };
});

// Only the real outbound Stripe API call is mocked - verifyWebhookSignature
// and parseCheckoutCompletedEvent are pure logic (own coverage in
// stripe.test.ts) and stay real here so the webhook route's tests exercise
// real signature verification against env.STRIPE_WEBHOOK_SECRET (from
// worker/.dev.vars locally), not a stubbed "always true".
vi.mock("../src/stripe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/stripe")>();
  return {
    ...actual,
    createDepositCheckoutSession: vi.fn(async () => ({ id: "cs_mock_123", url: "https://checkout.stripe.com/cs_mock_123" })),
  };
});

import { settlePayment, verifyPayment } from "../src/payment";
import type { PaymentPayload, PaymentRequirements } from "../src/payment";
import { enqueueRenderJob, getJobStatus, processRenderJob } from "../src/queue";
import type { RenderJob } from "../src/queue";
import { setCached } from "../src/cache";
import { tryLayer1Fetch } from "../src/layer1";
import { createDepositCheckoutSession } from "../src/stripe";
import { createAccount, getAccount } from "../src/credits";
import type { Env } from "../src/env";

const fakePaymentPayload: PaymentPayload = {
  x402Version: 1,
  scheme: "exact",
  network: "base-sepolia",
  payload: {
    signature: "0xfake",
    authorization: {
      from: "0xTestPayer",
      to: "0x000000000000000000000000000000000000dEaD",
      value: "80000",
      validAfter: "0",
      validBefore: "9999999999",
      nonce: "0xfake",
    },
  },
};

const fakePaymentRequirements: PaymentRequirements = {
  scheme: "exact",
  network: "base-sepolia",
  maxAmountRequired: "80000",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: "0x000000000000000000000000000000000000dEaD",
  resource: "https://example.com",
  description: "test fixture",
  mimeType: "application/json",
  outputSchema: null,
  maxTimeoutSeconds: 180,
  extra: { name: "USDC", version: "2" },
};

function fakePaymentHeader(): string {
  const payload = {
    x402Version: 1,
    scheme: "exact",
    network: "base-sepolia",
    payload: {
      signature: "0xfake",
      authorization: {
        from: "0xTestPayer",
        to: "0x000000000000000000000000000000000000dEaD",
        value: "2000",
        validAfter: "0",
        validBefore: "9999999999",
        nonce: "0xfake",
      },
    },
  };
  return btoa(JSON.stringify(payload));
}

function req(
  target: string,
  extraParams: Record<string, string> = {},
  headers: Record<string, string> = {},
  { withPayment = true }: { withPayment?: boolean } = {},
) {
  const url = new URL("https://worker.example/");
  url.searchParams.set("url", target);
  for (const [k, v] of Object.entries(extraParams)) url.searchParams.set(k, v);
  const finalHeaders = { ...headers };
  if (withPayment && !("x-payment" in finalHeaders)) finalHeaders["x-payment"] = fakePaymentHeader();
  return new Request(url, { headers: finalHeaders });
}

async function run(request: Request, testEnv: typeof env = env) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

beforeEach(() => {
  vi.mocked(verifyPayment).mockClear();
  vi.mocked(verifyPayment).mockResolvedValue({ isValid: true, payer: "0xTestPayer" });
  vi.mocked(settlePayment).mockClear();
  vi.mocked(settlePayment).mockResolvedValue({
    success: true,
    transaction: "0xMockTransactionHash",
    network: "base-sepolia",
    payer: "0xTestPayer",
  });
  vi.mocked(enqueueRenderJob).mockClear();
  vi.mocked(processRenderJob).mockClear();
  vi.mocked(processRenderJob).mockResolvedValue(undefined);
  vi.mocked(tryLayer1Fetch).mockClear();
  vi.mocked(tryLayer1Fetch).mockResolvedValue(null);
});

describe("Payment gate (x402)", () => {
  it("returns 402 with PaymentRequirements when X-PAYMENT is missing", async () => {
    const res = await run(req("https://example.com/", {}, {}, { withPayment: false }));
    expect(res.status).toBe(402);
    const body = (await res.json()) as { x402Version: number; accepts: { scheme: string; network: string }[] };
    expect(body.x402Version).toBe(1);
    expect(body.accepts[0]?.scheme).toBe("exact");
    expect(body.accepts[0]?.network).toBe("base-sepolia");
    expect(verifyPayment).not.toHaveBeenCalled();
  });

  it("returns 400 when X-PAYMENT is present but malformed", async () => {
    const res = await run(req("https://example.com/", {}, { "x-payment": "not-valid-base64-json" }));
    expect(res.status).toBe(400);
  });

  it("returns 402 when the facilitator rejects the payment", async () => {
    vi.mocked(verifyPayment).mockResolvedValueOnce({ isValid: false, invalidReason: "insufficient_funds" });
    const res = await run(req("https://example.com/"));
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("insufficient_funds");
  });

  it("returns 500 and never calls verifyPayment when PAY_TO_ADDRESS isn't configured", async () => {
    const res = await run(req("https://example.com/"), { ...env, PAY_TO_ADDRESS: "" });
    expect(res.status).toBe(500);
    expect(verifyPayment).not.toHaveBeenCalled();
  });

  it("verifies payment, queues a render job, and never settles on the still-unbuilt path", async () => {
    await env.ROBOTS_KV.put("robots:https://payment-ok.example", "");
    const res = await run(req("https://payment-ok.example/"));
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      status: string;
      jobId: string;
      pollUrl: string;
      payment: { verified: boolean; settled: boolean };
    };
    expect(body.status).toBe("pending");
    expect(body.pollUrl).toBe(`/v1/job/${body.jobId}`);
    expect(body.payment).toEqual({ verified: true, settled: false, payer: "0xTestPayer" });
    expect(enqueueRenderJob).toHaveBeenCalledWith(
      expect.anything(),
      "https://payment-ok.example/",
      expect.objectContaining({ kind: "x402" }),
    );
  });

  it("verifies payment but does not settle when the blocklist blocks the request", async () => {
    const res = await run(req("https://www.linkedin.com/in/someone"));
    expect(res.status).toBe(403);
    // verifyPayment ran (client proved they could pay), but the response
    // still carries cost:0 and there's no settlement call anywhere in
    // this codebase yet - see payment.ts.
    expect(verifyPayment).toHaveBeenCalled();
    expect(await res.json()).toEqual({ success: false, error: "BLOCKED_LEGAL_RISK", cost: 0 });
  });

  it("rate limits payment verification per-requester, blocking the facilitator call itself", async () => {
    const apiKey = "payment-verify-ratelimit-test-requester";
    // Rotate the target domain each iteration to prove the limit is NOT
    // domain-scoped - it must trip purely on requester identity.
    // ignore_robots=true so these fabricated domains don't trigger a real
    // (and here, DNS-failing) robots.txt fetch past the payment gate -
    // that's Step 1's concern, unrelated to what this test is checking.
    for (let i = 0; i < 300; i++) {
      const res = await run(
        req(`https://verify-rl-${i}.example/`, { ignore_robots: "true" }, { "x-api-key": apiKey }),
      );
      expect(res.status).not.toBe(429);
    }
    expect(verifyPayment).toHaveBeenCalledTimes(300);

    const res = await run(
      req("https://verify-rl-over-limit.example/", { ignore_robots: "true" }, { "x-api-key": apiKey }),
    );
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ success: false, error: "PAYMENT_VERIFY_RATE_LIMITED" });
    // The 301st call must never have reached verifyPayment - that's the
    // entire point (bound the facilitator call, not just the response).
    expect(verifyPayment).toHaveBeenCalledTimes(300);
  });

  it("does not consume the payment-verify rate limit bucket for requests that never reach the facilitator", async () => {
    const apiKey = "payment-verify-ratelimit-noop-requester";
    // Missing header (402, no decode) and malformed header (400, decode
    // fails) should both be free - neither calls verifyPayment, and
    // neither reaches Step 1's robots check either.
    for (let i = 0; i < 50; i++) {
      await run(req(`https://noop-${i}.example/`, {}, { "x-api-key": apiKey }, { withPayment: false }));
      await run(req(`https://noop-${i}.example/`, {}, { "x-api-key": apiKey, "x-payment": "garbage" }));
    }
    expect(verifyPayment).not.toHaveBeenCalled();
    // Bucket should still be empty - a real verify call now should succeed.
    const res = await run(
      req("https://noop-final.example/", { ignore_robots: "true" }, { "x-api-key": apiKey }),
    );
    expect(res.status).not.toBe(429);
    expect(verifyPayment).toHaveBeenCalledTimes(1);
  });
});

describe("Step 1: edge safety shield", () => {
  it("returns 400 when the url param is missing", async () => {
    const res = await run(new Request("https://worker.example/", { headers: { "x-payment": fakePaymentHeader() } }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when the url param is malformed", async () => {
    const res = await run(req("not-a-url"));
    expect(res.status).toBe(400);
  });

  it("blocks hard-blocklisted domains before touching anything else", async () => {
    const res = await run(req("https://www.linkedin.com/in/someone"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ success: false, error: "BLOCKED_LEGAL_RISK", cost: 0 });
  });

  it("blocks *.bank wildcard-TLD domains", async () => {
    const res = await run(req("https://mycreditunion.bank/accounts"));
    expect(res.status).toBe(403);
  });

  it("blocks domains added dynamically via BLOCKLIST_KV", async () => {
    await env.BLOCKLIST_KV.put("dynamic-blocklist:json", JSON.stringify(["paywalled-news.example"]));
    const res = await run(req("https://paywalled-news.example/article"));
    expect(res.status).toBe(403);
  });

  it("respects a cached robots.txt disallow", async () => {
    await env.ROBOTS_KV.put("robots:https://docs.example.com", "User-agent: *\nDisallow: /private");
    const res = await run(req("https://docs.example.com/private/page"));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("BLOCKED_ROBOTS_TXT");
  });

  it("passes an allowed path through to the queue", async () => {
    await env.ROBOTS_KV.put("robots:https://docs.example.com", "User-agent: *\nDisallow: /private");
    const res = await run(req("https://docs.example.com/public/page"));
    // 202 proves the shield let it through - the render pipeline behind
    // the queue is Steps 5-6.
    expect(res.status).toBe(202);
  });

  it("ignore_robots=true bypasses a robots.txt disallow", async () => {
    await env.ROBOTS_KV.put("robots:https://docs.example.com", "User-agent: *\nDisallow: /");
    const res = await run(req("https://docs.example.com/anything", { ignore_robots: "true" }));
    expect(res.status).toBe(202);
  });

  it("rate limits after 100 requests/min/domain from the same requester", async () => {
    await env.ROBOTS_KV.put("robots:https://ratelimit-test.example", "");
    for (let i = 0; i < 100; i++) {
      const res = await run(req("https://ratelimit-test.example/"));
      expect(res.status).toBe(202);
    }
    const res = await run(req("https://ratelimit-test.example/"));
    expect(res.status).toBe(429);
  });

  it("tracks rate limits per requester independently", async () => {
    await env.ROBOTS_KV.put("robots:https://per-requester-test.example", "");
    for (let i = 0; i < 100; i++) {
      const res = await run(req("https://per-requester-test.example/", {}, { "x-api-key": "tenant-a" }));
      expect(res.status).toBe(202);
    }
    const blocked = await run(req("https://per-requester-test.example/", {}, { "x-api-key": "tenant-a" }));
    expect(blocked.status).toBe(429);
    const other = await run(req("https://per-requester-test.example/", {}, { "x-api-key": "tenant-b" }));
    expect(other.status).toBe(202);
  });
});

describe("Job status polling (GET /v1/job/:id)", () => {
  it("returns 404 for an unknown job id", async () => {
    const res = await run(new Request("https://worker.example/v1/job/does-not-exist"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ success: false, error: "JOB_NOT_FOUND" });
  });

  it("returns a pending job's status without requiring payment or url params", async () => {
    await env.JOBS_KV.put("job:test-poll-pending", JSON.stringify({ status: "pending" }));
    // Deliberately no x-payment header and no ?url= - polling an
    // already-queued job isn't a new fetch request.
    const res = await run(new Request("https://worker.example/v1/job/test-poll-pending"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, jobId: "test-poll-pending", status: "pending" });
  });

  it("returns a completed job's status, including the delivered markdown", async () => {
    await env.JOBS_KV.put(
      "job:test-poll-done",
      JSON.stringify({ status: "done", markdown: "# Hello", providerUsed: "browserbase", completedAt: 123 }),
    );
    const res = await run(new Request("https://worker.example/v1/job/test-poll-done"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      jobId: "test-poll-done",
      status: "done",
      markdown: "# Hello",
      providerUsed: "browserbase",
      completedAt: 123,
    });
  });

  it("returns a failed job's status", async () => {
    await env.JOBS_KV.put(
      "job:test-poll-failed",
      JSON.stringify({ status: "failed", error: "RENDER_FAILED", completedAt: 456 }),
    );
    const res = await run(new Request("https://worker.example/v1/job/test-poll-failed"));
    expect(res.status).toBe(200);
    expect((await res.json() as { status: string }).status).toBe("failed");
  });
});

describe("Queue consumer (queue())", () => {
  function fakeMessage(job: RenderJob) {
    return {
      id: job.jobId,
      timestamp: new Date(),
      body: job,
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };
  }

  it("acks the message when processRenderJob succeeds", async () => {
    const job: RenderJob = {
      jobId: "consumer-ok",
      url: "https://example.com",
      attempt: 1,
      requestedAt: Date.now(),
      billing: { kind: "x402", paymentPayload: fakePaymentPayload, paymentRequirements: fakePaymentRequirements },
    };
    const message = fakeMessage(job);
    const batch = { messages: [message], queue: "quikgater-render-queue", ackAll: vi.fn(), retryAll: vi.fn() };

    await worker.queue(batch as unknown as MessageBatch<RenderJob>, env, createExecutionContext());

    expect(processRenderJob).toHaveBeenCalledWith(env, job);
    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("retries the message when processRenderJob throws", async () => {
    vi.mocked(processRenderJob).mockRejectedValueOnce(new Error("browser-worker unreachable"));
    const job: RenderJob = {
      jobId: "consumer-fail",
      url: "https://example.com",
      attempt: 1,
      requestedAt: Date.now(),
      billing: { kind: "x402", paymentPayload: fakePaymentPayload, paymentRequirements: fakePaymentRequirements },
    };
    const message = fakeMessage(job);
    const batch = { messages: [message], queue: "quikgater-render-queue", ackAll: vi.fn(), retryAll: vi.fn() };

    await worker.queue(batch as unknown as MessageBatch<RenderJob>, env, createExecutionContext());

    expect(message.retry).toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
  });
});

describe("Layer 0 cache (Step 5)", () => {
  it("short-circuits on a cache hit: 200 with the cached content, no job enqueued", async () => {
    const url = "https://cache-hit-test.example/docs/guide";
    await setCached(env, url, {
      title: "Cached Guide",
      etag: null,
      tierUsed: "L2-browserbase",
      markdown: "# Cached Guide\n\nAlready rendered.",
    });

    const res = await run(req(url, { ignore_robots: "true" }));

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      markdown: string;
      title: string;
      cacheHit: boolean;
      tierUsed: string;
      payment: { verified: boolean; settled: boolean; transaction: string };
    };
    expect(body).toMatchObject({
      markdown: "# Cached Guide\n\nAlready rendered.",
      title: "Cached Guide",
      cacheHit: true,
      tierUsed: "L2-browserbase",
    });
    // Cache hits settle synchronously - the outcome is already known, so
    // there's no async uncertainty to defer settlement past (unlike a miss).
    expect(body.payment).toEqual({
      verified: true,
      settled: true,
      transaction: "0xMockTransactionHash",
      payer: "0xTestPayer",
    });
    expect(settlePayment).toHaveBeenCalled();
    expect(enqueueRenderJob).not.toHaveBeenCalled();
  });

  it("the payment gate still applies even when the URL is cached", async () => {
    const url = "https://cache-hit-needs-payment.example/docs/x";
    await setCached(env, url, { title: "X", etag: null, tierUsed: "L3", markdown: "# X" });

    const res = await run(req(url, {}, {}, { withPayment: false }));

    expect(res.status).toBe(402); // missing X-PAYMENT - never even reaches the cache check
  });

  it("falls through to the queue on a cache miss, as before", async () => {
    const res = await run(req("https://definitely-not-cached.example/page", { ignore_robots: "true" }));
    expect(res.status).toBe(202);
    expect(enqueueRenderJob).toHaveBeenCalled();
  });

  it("returns 402 instead of serving content when settlement fails on a cache hit", async () => {
    vi.mocked(settlePayment).mockResolvedValueOnce({
      success: false,
      errorReason: "insufficient_funds",
      transaction: "",
      network: "base-sepolia",
      payer: "0xTestPayer",
    });
    const url = "https://cache-hit-settle-fail.example/docs/x";
    await setCached(env, url, { title: "X", etag: null, tierUsed: "L3", markdown: "# X" });

    const res = await run(req(url, { ignore_robots: "true" }));

    expect(res.status).toBe(402);
    expect((await res.json()) as { error: string }).toMatchObject({ error: expect.stringContaining("insufficient_funds") });
  });

  it("quotes the cache-hit price ($0.0002) when cached, and the miss price ($0.08) otherwise", async () => {
    const hitUrl = "https://price-check-hit.example/docs/x";
    await setCached(env, hitUrl, { title: "X", etag: null, tierUsed: "L3", markdown: "# X" });

    const hitRes = await run(req(hitUrl, {}, {}, { withPayment: false }));
    const hitBody = (await hitRes.json()) as { accepts: { maxAmountRequired: string }[] };
    expect(hitBody.accepts[0]?.maxAmountRequired).toBe("200");

    const missRes = await run(req("https://price-check-miss.example/page", {}, {}, { withPayment: false }));
    const missBody = (await missRes.json()) as { accepts: { maxAmountRequired: string }[] };
    expect(missBody.accepts[0]?.maxAmountRequired).toBe("80000");
  });
});

describe("Layer 1 (cheap in-Worker fetch)", () => {
  it("serves synchronously and settles when Layer 1 succeeds, without enqueuing a render job", async () => {
    vi.mocked(tryLayer1Fetch).mockResolvedValueOnce({
      markdown: "# A Real Page\n\nSome server-rendered text.",
      title: "A Real Page",
    });

    const res = await run(req("https://layer1-success.example/page", { ignore_robots: "true" }));

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      markdown: string;
      title: string;
      cacheHit: boolean;
      tierUsed: string;
      payment: { verified: boolean; settled: boolean };
    };
    expect(body).toMatchObject({
      markdown: "# A Real Page\n\nSome server-rendered text.",
      title: "A Real Page",
      cacheHit: false,
      tierUsed: "L1",
    });
    expect(body.payment).toEqual({
      verified: true,
      settled: true,
      transaction: "0xMockTransactionHash",
      payer: "0xTestPayer",
    });
    expect(settlePayment).toHaveBeenCalled();
    expect(enqueueRenderJob).not.toHaveBeenCalled();
  });

  it("populates the Layer 0 cache after a Layer 1 success, so the next request is a cache hit", async () => {
    vi.mocked(tryLayer1Fetch).mockResolvedValueOnce({
      markdown: "# Cache Me\n\nContent.",
      title: "Cache Me",
    });
    const url = "https://layer1-then-cache.example/page";

    const first = await run(req(url, { ignore_robots: "true" }));
    expect(first.status).toBe(200);

    const second = await run(req(url, { ignore_robots: "true" }));
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { cacheHit: boolean; tierUsed: string };
    expect(secondBody.cacheHit).toBe(true);
    expect(secondBody.tierUsed).toBe("L1");
    // Second request is a real Layer 0 hit - Layer 1 shouldn't run again.
    expect(tryLayer1Fetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to the queue when Layer 1 returns null", async () => {
    // Default mock already resolves to null - this is the pre-Layer-1
    // behavior, explicitly asserted rather than just relied upon.
    const res = await run(req("https://layer1-fails.example/page", { ignore_robots: "true" }));
    expect(res.status).toBe(202);
    expect(tryLayer1Fetch).toHaveBeenCalledWith("https://layer1-fails.example/page");
    expect(enqueueRenderJob).toHaveBeenCalled();
  });

  it("does not serve Layer 1 content when settlement fails", async () => {
    vi.mocked(tryLayer1Fetch).mockResolvedValueOnce({ markdown: "# X", title: "X" });
    vi.mocked(settlePayment).mockResolvedValueOnce({
      success: false,
      errorReason: "insufficient_funds",
      transaction: "",
      network: "base-sepolia",
      payer: "0xTestPayer",
    });

    const res = await run(req("https://layer1-settle-fail.example/page", { ignore_robots: "true" }));

    expect(res.status).toBe(402);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("insufficient_funds"),
    });
  });

  it("still quotes the full miss price ($0.08) up front, even for a URL Layer 1 will end up handling", async () => {
    // Layer 1's outcome isn't known until after payment is verified, so
    // the up-front 402 quote can't reflect it yet - see layer1.ts.
    const res = await run(
      req("https://layer1-price-check.example/page", {}, {}, { withPayment: false }),
    );
    const body = (await res.json()) as { accepts: { maxAmountRequired: string }[] };
    expect(body.accepts[0]?.maxAmountRequired).toBe("80000");
  });
});

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function fakeStripeSignatureHeader(secret: string, rawBody: string): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const v1 = await hmacHex(secret, `${timestamp}.${rawBody}`);
  return `t=${timestamp},v1=${v1}`;
}

describe("Rail B: POST /v1/credits/checkout", () => {
  it("mints a new API key and account when none is provided", async () => {
    const res = await run(
      new Request("https://worker.example/v1/credits/checkout", {
        method: "POST",
        body: JSON.stringify({ amountUsd: 20 }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; apiKey: string; isNewAccount: boolean; checkoutUrl: string };
    expect(body.success).toBe(true);
    expect(body.apiKey).toMatch(/^qg_/);
    expect(body.isNewAccount).toBe(true);
    expect(body.checkoutUrl).toBe("https://checkout.stripe.com/cs_mock_123");
    expect(await getAccount(env as Env, body.apiKey)).toMatchObject({ balanceAtomic: 0 });
    expect(createDepositCheckoutSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ amountUsd: 20, apiKey: body.apiKey }),
    );
  });

  it("reuses an existing account when an apiKey is provided", async () => {
    await createAccount(env as Env, "qg_existing_checkout");
    const res = await run(
      new Request("https://worker.example/v1/credits/checkout", {
        method: "POST",
        body: JSON.stringify({ amountUsd: 5, apiKey: "qg_existing_checkout" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { apiKey: string; isNewAccount: boolean };
    expect(body.apiKey).toBe("qg_existing_checkout");
    expect(body.isNewAccount).toBe(false);
  });

  it("rejects an unknown apiKey", async () => {
    const res = await run(
      new Request("https://worker.example/v1/credits/checkout", {
        method: "POST",
        body: JSON.stringify({ amountUsd: 5, apiKey: "qg_does_not_exist" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects an amount outside the spec's $5/$20/$100 tiers", async () => {
    const res = await run(
      new Request("https://worker.example/v1/credits/checkout", { method: "POST", body: JSON.stringify({ amountUsd: 7 }) }),
    );
    expect(res.status).toBe(400);
  });
});

describe("Rail B: POST /v1/stripe/webhook", () => {
  it("credits the account on a validly signed checkout.session.completed event", async () => {
    await createAccount(env as Env, "qg_webhook_credit");
    const rawBody = JSON.stringify({
      type: "checkout.session.completed",
      data: { object: { metadata: { apiKey: "qg_webhook_credit" }, amount_total: 2000 } }, // $20.00
    });
    const signature = await fakeStripeSignatureHeader("whsec_fake_for_local_dev_only", rawBody);

    const res = await run(
      new Request("https://worker.example/v1/stripe/webhook", {
        method: "POST",
        headers: { "stripe-signature": signature },
        body: rawBody,
      }),
    );

    expect(res.status).toBe(200);
    const account = await getAccount(env as Env, "qg_webhook_credit");
    expect(account?.balanceAtomic).toBe(20_000_000); // $20.00 in atomic units
  });

  it("rejects a request with an invalid signature", async () => {
    const rawBody = JSON.stringify({
      type: "checkout.session.completed",
      data: { object: { metadata: { apiKey: "qg_should_not_be_credited" }, amount_total: 2000 } },
    });
    const badSignature = await fakeStripeSignatureHeader("whsec_totally_wrong", rawBody);

    const res = await run(
      new Request("https://worker.example/v1/stripe/webhook", {
        method: "POST",
        headers: { "stripe-signature": badSignature },
        body: rawBody,
      }),
    );

    expect(res.status).toBe(400);
    expect(await getAccount(env as Env, "qg_should_not_be_credited")).toBeNull();
  });

  it("rejects a request with no signature header at all", async () => {
    const res = await run(new Request("https://worker.example/v1/stripe/webhook", { method: "POST", body: "{}" }));
    expect(res.status).toBe(400);
  });
});

describe("Rail B: GET /v1/credits/balance", () => {
  it("returns the account balance for a valid Bearer token", async () => {
    await createAccount(env as Env, "qg_balance_check");
    await env.CREDITS_KV.put("account:qg_balance_check", JSON.stringify({ apiKey: "qg_balance_check", balanceAtomic: 5_500_000, createdAt: Date.now() }));
    const res = await run(new Request("https://worker.example/v1/credits/balance", { headers: { authorization: "Bearer qg_balance_check" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, apiKey: "qg_balance_check", balanceAtomic: 5_500_000, balanceUsd: 5.5 });
  });

  it("returns 401 with no Authorization header", async () => {
    const res = await run(new Request("https://worker.example/v1/credits/balance"));
    expect(res.status).toBe(401);
  });

  it("returns 401 for an unknown API key", async () => {
    const res = await run(new Request("https://worker.example/v1/credits/balance", { headers: { authorization: "Bearer qg_nope" } }));
    expect(res.status).toBe(401);
  });
});

describe("Rail B: Bearer token billing", () => {
  it("returns 401 for an unknown API key", async () => {
    const res = await run(req("https://bearer-unknown.example/page", {}, { authorization: "Bearer qg_does_not_exist" }, { withPayment: false }));
    expect(res.status).toBe(401);
  });

  it("returns 402 with balance details when the account can't cover the worst-case price", async () => {
    await createAccount(env as Env, "qg_bearer_broke");
    const res = await run(req("https://bearer-broke.example/page", {}, { authorization: "Bearer qg_bearer_broke" }, { withPayment: false }));
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ success: false, error: "INSUFFICIENT_CREDITS", balanceAtomic: 0 });
  });

  it("debits the cache-hit price and serves cached content synchronously", async () => {
    await createAccount(env as Env, "qg_bearer_cache_hit");
    await env.CREDITS_KV.put("account:qg_bearer_cache_hit", JSON.stringify({ apiKey: "qg_bearer_cache_hit", balanceAtomic: 1_000_000, createdAt: Date.now() }));
    const url = "https://bearer-cache-hit.example/docs";
    await setCached(env, url, { title: "Cached", etag: null, tierUsed: "L2-browserbase", markdown: "# Cached" });

    const res = await run(req(url, { ignore_robots: "true" }, { authorization: "Bearer qg_bearer_cache_hit" }, { withPayment: false }));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { cacheHit: boolean; payment: { method: string; debitedAtomic: number; newBalanceAtomic: number } };
    expect(body.cacheHit).toBe(true);
    expect(body.payment).toEqual({ method: "credits", debitedAtomic: 200, newBalanceAtomic: 999_800 });
  });

  it("debits the real Layer 1 price ($0.002), not Rail A's worst-case $0.08", async () => {
    vi.mocked(tryLayer1Fetch).mockResolvedValueOnce({ markdown: "# Real Content", title: "Real Content" });
    await env.CREDITS_KV.put("account:qg_bearer_layer1", JSON.stringify({ apiKey: "qg_bearer_layer1", balanceAtomic: 1_000_000, createdAt: Date.now() }));

    const res = await run(
      req("https://bearer-layer1.example/page", { ignore_robots: "true" }, { authorization: "Bearer qg_bearer_layer1" }, { withPayment: false }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { tierUsed: string; payment: { debitedAtomic: number; newBalanceAtomic: number } };
    expect(body.tierUsed).toBe("L1");
    expect(body.payment).toEqual({ method: "credits", debitedAtomic: 2000, newBalanceAtomic: 998_000 });
  });

  it("enqueues a credits-billed render job when both cache and Layer 1 miss", async () => {
    await env.CREDITS_KV.put("account:qg_bearer_miss", JSON.stringify({ apiKey: "qg_bearer_miss", balanceAtomic: 1_000_000, createdAt: Date.now() }));

    const res = await run(
      req("https://bearer-miss.example/page", { ignore_robots: "true" }, { authorization: "Bearer qg_bearer_miss" }, { withPayment: false }),
    );

    expect(res.status).toBe(202);
    expect(enqueueRenderJob).toHaveBeenCalledWith(
      expect.anything(),
      "https://bearer-miss.example/page",
      { kind: "credits", apiKey: "qg_bearer_miss" },
    );
  });

  it("still enforces the blocklist for Bearer-billed requests", async () => {
    await env.CREDITS_KV.put("account:qg_bearer_blocked", JSON.stringify({ apiKey: "qg_bearer_blocked", balanceAtomic: 1_000_000, createdAt: Date.now() }));
    const res = await run(req("https://www.linkedin.com/in/someone", {}, { authorization: "Bearer qg_bearer_blocked" }, { withPayment: false }));
    expect(res.status).toBe(403);
  });
});
