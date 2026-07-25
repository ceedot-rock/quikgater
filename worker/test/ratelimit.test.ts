import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { checkPaymentVerifyRateLimit, checkRateLimit } from "../src/ratelimit";

describe("checkRateLimit (per requester+domain, 100/min)", () => {
  it("allows up to the limit and blocks the next one", async () => {
    const requester = "rl-domain-test-requester";
    const domain = "rl-domain-test.example";
    for (let i = 0; i < 100; i++) {
      const { limited } = await checkRateLimit(env, requester, domain);
      expect(limited).toBe(false);
    }
    const { limited, count } = await checkRateLimit(env, requester, domain);
    expect(limited).toBe(true);
    expect(count).toBe(101);
  });

  it("keeps separate buckets per domain for the same requester", async () => {
    const requester = "rl-domain-isolation-requester";
    for (let i = 0; i < 100; i++) {
      await checkRateLimit(env, requester, "domain-a.example");
    }
    // domain-a is now at the limit, domain-b should be unaffected
    const domainA = await checkRateLimit(env, requester, "domain-a.example");
    const domainB = await checkRateLimit(env, requester, "domain-b.example");
    expect(domainA.limited).toBe(true);
    expect(domainB.limited).toBe(false);
  });

  it("doubles the ceiling to 200/min for a Pro caller (isPro=true)", async () => {
    const requester = "rl-pro-requester";
    const domain = "rl-pro-test.example";
    for (let i = 0; i < 200; i++) {
      const { limited } = await checkRateLimit(env, requester, domain, true);
      expect(limited).toBe(false);
    }
    const { limited, count } = await checkRateLimit(env, requester, domain, true);
    expect(limited).toBe(true);
    expect(count).toBe(201);
  });

  it("shares the same counter bucket regardless of isPro - it only changes the ceiling, not the key", async () => {
    const requester = "rl-pro-shared-bucket-requester";
    const domain = "rl-pro-shared-bucket.example";
    for (let i = 0; i < 100; i++) {
      await checkRateLimit(env, requester, domain, false);
    }
    // Same (requester, domain, window) bucket is already at 100 - a Pro
    // call keeps incrementing it, just against double the ceiling.
    const proResult = await checkRateLimit(env, requester, domain, true);
    expect(proResult.count).toBe(101);
    expect(proResult.limited).toBe(false);
  });
});

describe("checkPaymentVerifyRateLimit (per requester only, 300/min)", () => {
  it("allows up to the limit and blocks the next one", async () => {
    const requester = "rl-verify-test-requester";
    for (let i = 0; i < 300; i++) {
      const { limited } = await checkPaymentVerifyRateLimit(env, requester);
      expect(limited).toBe(false);
    }
    const { limited, count } = await checkPaymentVerifyRateLimit(env, requester);
    expect(limited).toBe(true);
    expect(count).toBe(301);
  });

  it("is NOT scoped by domain - it's a single bucket per requester regardless of target", async () => {
    // checkPaymentVerifyRateLimit takes no domain argument at all, so
    // rotating target domains (which the payment gate itself doesn't
    // pass through here) can never reset or split this bucket.
    const requester = "rl-verify-isolation-requester";
    for (let i = 0; i < 300; i++) {
      await checkPaymentVerifyRateLimit(env, requester);
    }
    const { limited } = await checkPaymentVerifyRateLimit(env, requester);
    expect(limited).toBe(true);
  });

  it("keeps separate buckets per requester", async () => {
    const a = "rl-verify-requester-a";
    const b = "rl-verify-requester-b";
    for (let i = 0; i < 300; i++) {
      await checkPaymentVerifyRateLimit(env, a);
    }
    const resultA = await checkPaymentVerifyRateLimit(env, a);
    const resultB = await checkPaymentVerifyRateLimit(env, b);
    expect(resultA.limited).toBe(true);
    expect(resultB.limited).toBe(false);
  });
});
