import { env } from "cloudflare:test";
import { describe, expect, it, vi, beforeEach } from "vitest";

// settlePayment is mocked here too - processRenderJob calls it for real
// otherwise, which would hit the actual facilitator with a fake fixture
// signature. verifyPayment/buildPaymentRequirements etc. stay real since
// nothing here exercises them directly.
vi.mock("../src/payment", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/payment")>();
  return {
    ...actual,
    settlePayment: vi.fn(async () => ({
      success: true,
      transaction: "0xMockTransactionHash",
      network: "base-sepolia",
      payer: "0xTestPayer",
    })),
  };
});

import { enqueueRenderJob, getJobStatus, processRenderJob } from "../src/queue";
import { getCached } from "../src/cache";
import { settlePayment } from "../src/payment";
import type { PaymentPayload, PaymentRequirements } from "../src/payment";
// credits.ts is real KV read/writes here, not mocked - unlike
// settlePayment, it has no real network call to avoid, so there's no
// reason to fake it; Miniflare simulates CREDITS_KV locally same as any
// other KV binding.
import { createAccount, getAccount } from "../src/credits";
import type { Env } from "../src/env";
import type { RenderJob, Billing } from "../src/queue";

// Real queue.ts logic, unmocked - worker.test.ts mocks this module so
// index.ts's own tests don't touch Miniflare's real (async, background)
// local queue simulator, which corrupts test-to-test storage isolation
// under load. Here RENDER_QUEUE.send itself is still stubbed (we're not
// testing Cloudflare's queue delivery, just our own producer/consumer
// logic around it), but everything else - JOBS_KV, the actual functions
// under test - is real.
function testEnv(overrides: Partial<Env> = {}): Env {
  return { ...env, RENDER_QUEUE: { send: vi.fn() } as unknown as Env["RENDER_QUEUE"], ...overrides } as Env;
}

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

beforeEach(() => {
  vi.mocked(settlePayment).mockClear();
  vi.mocked(settlePayment).mockResolvedValue({
    success: true,
    transaction: "0xMockTransactionHash",
    network: "base-sepolia",
    payer: "0xTestPayer",
  });
});

const x402Billing: Billing = { kind: "x402", paymentPayload: fakePaymentPayload, paymentRequirements: fakePaymentRequirements };

describe("enqueueRenderJob", () => {
  it("writes a pending status to JOBS_KV before sending to the queue", async () => {
    const e = testEnv();
    const { jobId } = await enqueueRenderJob(e, "https://example.com/docs", x402Billing);

    expect(e.RENDER_QUEUE.send).toHaveBeenCalledTimes(1);
    const sentJob = vi.mocked(e.RENDER_QUEUE.send).mock.calls[0]?.[0] as RenderJob;
    expect(sentJob.jobId).toBe(jobId);
    expect(sentJob.url).toBe("https://example.com/docs");
    expect(sentJob.attempt).toBe(1);
    expect(sentJob.billing).toEqual(x402Billing);

    const status = await getJobStatus(e, jobId);
    expect(status).toEqual({ status: "pending" });
  });

  it("generates a unique job id per call", async () => {
    const e = testEnv();
    const a = await enqueueRenderJob(e, "https://example.com/a", x402Billing);
    const b = await enqueueRenderJob(e, "https://example.com/b", x402Billing);
    expect(a.jobId).not.toBe(b.jobId);
  });

  it("also accepts credits (Rail B) billing", async () => {
    const e = testEnv();
    const { jobId } = await enqueueRenderJob(e, "https://example.com/credits-job", { kind: "credits", apiKey: "qg_test" });
    const sentJob = vi.mocked(e.RENDER_QUEUE.send).mock.calls[0]?.[0] as RenderJob;
    expect(sentJob.jobId).toBe(jobId);
    expect(sentJob.billing).toEqual({ kind: "credits", apiKey: "qg_test" });
  });
});

describe("getJobStatus", () => {
  it("returns null for an unknown job id", async () => {
    const status = await getJobStatus(env as Env, "totally-unknown-job-id");
    expect(status).toBeNull();
  });
});

describe("processRenderJob", () => {
  function job(id: string, url: string, billing: Billing = x402Billing): RenderJob {
    return {
      jobId: id,
      url,
      attempt: 1,
      requestedAt: Date.now(),
      billing,
    };
  }

  it("marks the job done, settles the payment, and populates the cache when /render succeeds", async () => {
    const e = testEnv({ BROWSER_WORKER_URL: "https://browser-worker.test" });
    const j = job("process-render-ok", "https://cache-populate-render.example/docs/x");
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://browser-worker.test/render");
      return new Response(JSON.stringify({ markdown: "# Hello\n\nBody.", providerUsed: "browserbase" }), {
        status: 200,
      });
    });

    await processRenderJob(e, j, fetchImpl as unknown as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(settlePayment).toHaveBeenCalledWith(fakePaymentPayload, fakePaymentRequirements);
    const status = await getJobStatus(e, j.jobId);
    expect(status).toMatchObject({
      status: "done",
      markdown: "# Hello\n\nBody.",
      providerUsed: "browserbase",
      settled: true,
      transaction: "0xMockTransactionHash",
    });

    const cached = await getCached(e, j.url);
    expect(cached).not.toBeNull();
    expect(cached?.markdown).toBe("# Hello\n\nBody.");
    expect(cached?.metadata).toMatchObject({ title: "Hello", tierUsed: "L2-browserbase" });
  });

  it("falls back to /hard-fallback when /render fails, marks done, settles, and caches under tier L3", async () => {
    const e = testEnv({ BROWSER_WORKER_URL: "https://browser-worker.test" });
    const j = job("process-render-fallback-ok", "https://cache-populate-fallback.example/docs/y");
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/render")) return new Response("layer 2 down", { status: 502 });
      return new Response(JSON.stringify({ markdown: "# Fallback", provider: "scraperapi" }), { status: 200 });
    });

    await processRenderJob(e, j, fetchImpl as unknown as typeof fetch);

    expect(calls).toEqual([
      "https://browser-worker.test/render",
      "https://browser-worker.test/hard-fallback",
    ]);
    expect(settlePayment).toHaveBeenCalledTimes(1);
    const status = await getJobStatus(e, j.jobId);
    expect(status).toMatchObject({ status: "done", markdown: "# Fallback", providerUsed: "scraperapi", settled: true });

    const cached = await getCached(e, j.url);
    expect(cached?.metadata).toMatchObject({ tierUsed: "L3" });
  });

  it("marks the job failed, never settles, and caches nothing when both /render and /hard-fallback fail", async () => {
    const e = testEnv({ BROWSER_WORKER_URL: "https://browser-worker.test" });
    const j = job("process-render-both-fail", "https://cache-populate-neither.example/docs/z");
    const fetchImpl = vi.fn(async () => new Response("down", { status: 502 }));

    await processRenderJob(e, j, fetchImpl as unknown as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(settlePayment).not.toHaveBeenCalled();
    const status = await getJobStatus(e, j.jobId);
    expect(status).toMatchObject({ status: "failed", error: "RENDER_FAILED" });

    const cached = await getCached(e, j.url);
    expect(cached).toBeNull();
  });

  it("still returns the content when render succeeds but settlement fails, marked unsettled", async () => {
    vi.mocked(settlePayment).mockResolvedValueOnce({
      success: false,
      errorReason: "invalid_exact_evm_payload_authorization_valid_before",
      transaction: "",
      network: "base-sepolia",
      payer: "0xTestPayer",
    });
    const e = testEnv({ BROWSER_WORKER_URL: "https://browser-worker.test" });
    const j = job("process-render-settle-fail", "https://cache-populate-settle-fail.example/docs/w");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ markdown: "# Ok", providerUsed: "browserbase" }), { status: 200 }));

    await processRenderJob(e, j, fetchImpl as unknown as typeof fetch);

    const status = await getJobStatus(e, j.jobId);
    expect(status).toMatchObject({
      status: "done",
      markdown: "# Ok",
      settled: false,
      settlementError: "invalid_exact_evm_payload_authorization_valid_before",
    });
    // Content was still rendered, so it's still cached - the settlement
    // failure is a billing problem, not a reason to throw away the work.
    const cached = await getCached(e, j.url);
    expect(cached).not.toBeNull();
  });

  describe("Rail B (credits) billing", () => {
    it("debits the real tier price (not a pre-quoted worst case) once the render succeeds", async () => {
      const e = testEnv({ BROWSER_WORKER_URL: "https://browser-worker.test" });
      await createAccount(e, "qg_credits_render_ok");
      // Give it more than $0.08 so the debit can actually succeed.
      await e.CREDITS_KV.put("account:qg_credits_render_ok", JSON.stringify({ apiKey: "qg_credits_render_ok", balanceAtomic: 1_000_000, createdAt: Date.now() }));

      const j = job("process-credits-render-ok", "https://credits-render.example/docs", { kind: "credits", apiKey: "qg_credits_render_ok" });
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ markdown: "# Hi", providerUsed: "browserbase" }), { status: 200 }));

      await processRenderJob(e, j, fetchImpl as unknown as typeof fetch);

      const status = await getJobStatus(e, j.jobId);
      expect(status).toMatchObject({ status: "done", settled: true });
      const account = await getAccount(e, "qg_credits_render_ok");
      // 1,000,000 - 80,000 (MISS_PRICE_ATOMIC, the L2 tier price) = 920,000
      expect(account?.balanceAtomic).toBe(920_000);
    });

    it("charges the $0.0001 failure price on total failure - something Rail A structurally can't do", async () => {
      const e = testEnv({ BROWSER_WORKER_URL: "https://browser-worker.test" });
      await e.CREDITS_KV.put("account:qg_credits_fail", JSON.stringify({ apiKey: "qg_credits_fail", balanceAtomic: 1_000_000, createdAt: Date.now() }));

      const j = job("process-credits-fail", "https://credits-fail.example/docs", { kind: "credits", apiKey: "qg_credits_fail" });
      const fetchImpl = vi.fn(async () => new Response("down", { status: 502 }));

      await processRenderJob(e, j, fetchImpl as unknown as typeof fetch);

      const status = await getJobStatus(e, j.jobId);
      expect(status).toMatchObject({ status: "failed", error: "RENDER_FAILED" });
      const account = await getAccount(e, "qg_credits_fail");
      // 1,000,000 - 100 (FAILURE_PRICE_ATOMIC) = 999,900
      expect(account?.balanceAtomic).toBe(999_900);
    });

    it("marks the job unsettled (but still returns content) when the debit fails despite a successful render", async () => {
      const e = testEnv({ BROWSER_WORKER_URL: "https://browser-worker.test" });
      // Balance too low to cover the $0.08 render tier once it's actually charged.
      await e.CREDITS_KV.put("account:qg_credits_broke", JSON.stringify({ apiKey: "qg_credits_broke", balanceAtomic: 100, createdAt: Date.now() }));

      const j = job("process-credits-broke", "https://credits-broke.example/docs", { kind: "credits", apiKey: "qg_credits_broke" });
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ markdown: "# Ok", providerUsed: "browserbase" }), { status: 200 }));

      await processRenderJob(e, j, fetchImpl as unknown as typeof fetch);

      const status = await getJobStatus(e, j.jobId);
      expect(status).toMatchObject({ status: "done", markdown: "# Ok", settled: false, settlementError: "INSUFFICIENT_CREDITS" });
    });
  });
});
