import type { Env } from "./env";
import { isBlocklisted } from "./blocklist";
import { getRobotsTxt, robotsAllows } from "./robots";
import { checkPaymentVerifyRateLimit, checkRateLimit } from "./ratelimit";
import {
  buildPaymentRequirements,
  decodePaymentHeader,
  paymentRequiredBody,
  settlePayment,
  verifyPayment,
  CACHE_HIT_PRICE_ATOMIC,
  MISS_PRICE_ATOMIC,
  STANDARD_FETCH_PRICE_ATOMIC,
} from "./payment";
import { enqueueRenderJob, getJobStatus, processRenderJob, type RenderJob } from "./queue";
import { getCached, setCached } from "./cache";
import { logRequestCost } from "./costlog";
import { tryLayer1Fetch } from "./layer1";
import { createAccount, creditAccount, debitAccount, generateApiKey, getAccount } from "./credits";
import { createDepositCheckoutSession, isValidDepositAmount, parseCheckoutCompletedEvent, verifyWebhookSignature } from "./stripe";

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const JOB_STATUS_PATH_PREFIX = "/v1/job/";

/**
 * Step 1 (Edge Safety), shared between Rail A (x402) and Rail B (credits) -
 * both bill differently, but neither should ever touch a blocklisted,
 * robots-disallowed, or rate-limited request. See index.ts's two billing
 * branches for where each rail calls this, and why it runs at a different
 * point relative to their respective payment checks.
 */
async function runStep1Checks(env: Env, target: string, targetUrl: URL, requesterId: string, url: URL): Promise<Response | null> {
  const dynamicListRaw = await env.BLOCKLIST_KV.get("dynamic-blocklist:json");
  const dynamicPatterns: string[] = dynamicListRaw ? JSON.parse(dynamicListRaw) : [];
  const blockResult = isBlocklisted(targetUrl.hostname, dynamicPatterns);
  if (blockResult.blocked) {
    // No settlement/debit on a block, per spec §2.
    return jsonResponse({ success: false, error: "BLOCKED_LEGAL_RISK", cost: 0 }, 403);
  }

  const ignoreRobots = url.searchParams.get("ignore_robots") === "true";
  if (!ignoreRobots) {
    const robotsTxt = await getRobotsTxt(targetUrl.origin, env);
    if (!robotsAllows(robotsTxt, targetUrl.pathname)) {
      return jsonResponse({ success: false, error: "BLOCKED_ROBOTS_TXT", cost: 0 }, 403);
    }
  } else {
    // TODO: route this into the real Tinybird request log instead of
    // console.log once a token exists.
    console.log(JSON.stringify({ event: "ignore_robots_used", url: target }));
  }

  const { limited } = await checkRateLimit(env, requesterId, targetUrl.hostname);
  if (limited) {
    return jsonResponse({ success: false, error: "RATE_LIMITED" }, 429);
  }

  return null;
}

/**
 * Rail B (spec §5): starts (or tops up) a deposit via a real Stripe
 * Checkout Session. `apiKey` is optional in the request body - a
 * brand-new user gets one minted here, before they've paid anything, so
 * the Stripe webhook has an account to credit once checkout completes.
 */
async function handleCreditsCheckout(request: Request, env: Env): Promise<Response> {
  let body: { amountUsd?: number; apiKey?: string };
  try {
    body = (await request.json()) as { amountUsd?: number; apiKey?: string };
  } catch {
    return jsonResponse({ success: false, error: "INVALID_JSON_BODY" }, 400);
  }

  if (typeof body.amountUsd !== "number" || !isValidDepositAmount(body.amountUsd)) {
    return jsonResponse({ success: false, error: "INVALID_DEPOSIT_AMOUNT", allowed: [5, 20, 100] }, 400);
  }

  let apiKey = body.apiKey;
  let isNewAccount = false;
  if (apiKey) {
    const existing = await getAccount(env, apiKey);
    if (!existing) return jsonResponse({ success: false, error: "INVALID_API_KEY" }, 401);
  } else {
    apiKey = generateApiKey();
    await createAccount(env, apiKey);
    isNewAccount = true;
  }

  const origin = new URL(request.url).origin;
  const session = await createDepositCheckoutSession(env, {
    amountUsd: body.amountUsd,
    apiKey,
    successUrl: `${origin}/v1/credits/success`,
    cancelUrl: `${origin}/v1/credits/cancel`,
  });

  return jsonResponse({ success: true, apiKey, isNewAccount, checkoutUrl: session.url, sessionId: session.id }, 200);
}

/**
 * Real Stripe webhook receiver for `checkout.session.completed` - the
 * only thing that actually adds credits to an account. Signature
 * verification (stripe.ts) is mandatory; there is no other authentication
 * on this route, so an unverified request could otherwise mint free
 * credits for any apiKey it names.
 */
async function handleStripeWebhook(request: Request, env: Env): Promise<Response> {
  const signature = request.headers.get("stripe-signature");
  const rawBody = await request.text();
  if (!signature || !(await verifyWebhookSignature(rawBody, signature, env.STRIPE_WEBHOOK_SECRET))) {
    return jsonResponse({ success: false, error: "INVALID_SIGNATURE" }, 400);
  }

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return jsonResponse({ success: false, error: "INVALID_JSON_BODY" }, 400);
  }

  const completed = parseCheckoutCompletedEvent(event);
  if (!completed) {
    // Signature-verified but not the event type we handle (the endpoint
    // is only subscribed to checkout.session.completed, but defensive
    // either way) - ack with 200 so Stripe doesn't retry indefinitely.
    return jsonResponse({ success: true, ignored: true }, 200);
  }

  const amountAtomic = completed.amountTotalCents * 10_000; // Stripe cents -> atomic units (1e-6 USD), see credits.ts
  await creditAccount(env, completed.apiKey, amountAtomic);
  return jsonResponse({ success: true }, 200);
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const requestStart = Date.now();
    const url = new URL(request.url);

    // Job status polling (spec §8 Step 4: "GET /v1/job/{id}"). Handled
    // before anything else - it's a status lookup for a job that was
    // already paid for and queued, not a new fetch request, so it
    // shouldn't go through either billing rail or Step 1 checks again.
    // Access control is deliberately just "knows the job ID" for now
    // (jobId is an unguessable crypto.randomUUID()) - fine for Step 4,
    // revisit if that's not enough once real users exist.
    if (url.pathname.startsWith(JOB_STATUS_PATH_PREFIX)) {
      const jobId = url.pathname.slice(JOB_STATUS_PATH_PREFIX.length);
      const status = await getJobStatus(env, jobId);
      if (!status) {
        return jsonResponse({ success: false, error: "JOB_NOT_FOUND" }, 404);
      }
      return jsonResponse({ success: true, jobId, ...status }, 200);
    }

    // Rail B account/billing management routes - not `?url=` fetch
    // requests at all, handled entirely separately.
    if (url.pathname === "/v1/credits/checkout" && request.method === "POST") {
      return handleCreditsCheckout(request, env);
    }
    if (url.pathname === "/v1/stripe/webhook" && request.method === "POST") {
      return handleStripeWebhook(request, env);
    }
    if (url.pathname === "/v1/credits/success") {
      return jsonResponse({ success: true, message: "Checkout complete. Credits will appear once Stripe's webhook confirms payment." }, 200);
    }
    if (url.pathname === "/v1/credits/cancel") {
      return jsonResponse({ success: false, message: "Checkout cancelled. No charge was made." }, 200);
    }
    if (url.pathname === "/v1/credits/balance") {
      const authHeaderForBalance = request.headers.get("authorization");
      const apiKeyForBalance = authHeaderForBalance?.startsWith("Bearer ") ? authHeaderForBalance.slice("Bearer ".length) : null;
      if (!apiKeyForBalance) return jsonResponse({ success: false, error: "MISSING_BEARER_TOKEN" }, 401);
      const account = await getAccount(env, apiKeyForBalance);
      if (!account) return jsonResponse({ success: false, error: "INVALID_API_KEY" }, 401);
      return jsonResponse({ success: true, apiKey: account.apiKey, balanceAtomic: account.balanceAtomic, balanceUsd: account.balanceAtomic / 1_000_000 }, 200);
    }

    const target = url.searchParams.get("url");
    if (!target) {
      return jsonResponse({ success: false, error: "MISSING_URL_PARAM" }, 400);
    }

    let targetUrl: URL;
    try {
      targetUrl = new URL(target);
    } catch {
      return jsonResponse({ success: false, error: "INVALID_URL" }, 400);
    }

    // Extracted early because both billing rails and the Step 1 domain
    // limiter below need it.
    const requesterId =
      request.headers.get("x-api-key") ?? request.headers.get("cf-connecting-ip") ?? "anonymous";

    // --- Rail B: Bearer token / deposit credits (spec §5). Checked first -
    // if a client presents an API key, this request is billed via the
    // credits ledger instead of x402, skipping the entire facilitator
    // round-trip entirely. A request with both an Authorization header and
    // an X-PAYMENT header uses credits; X-PAYMENT is simply never read. ---
    const authHeader = request.headers.get("authorization");
    const bearerApiKey = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;

    if (bearerApiKey) {
      const account = await getAccount(env, bearerApiKey);
      if (!account) {
        return jsonResponse({ success: false, error: "INVALID_API_KEY" }, 401);
      }

      // Worst-case pre-check, mirroring Rail A's pre-quote logic: prove
      // the account can cover a full render before doing any work, since
      // there's no signature here to prove ability-to-pay the way x402
      // has. The REAL amount debited is decided per-tier once the outcome
      // is known (queue.ts's settleBilling / payment.ts's
      // priceAtomicForTier) - this is only a "can they afford the worst
      // case" gate, not the final charge.
      if (account.balanceAtomic < Number(MISS_PRICE_ATOMIC)) {
        return jsonResponse(
          {
            success: false,
            error: "INSUFFICIENT_CREDITS",
            balanceAtomic: account.balanceAtomic,
            requiredAtomic: Number(MISS_PRICE_ATOMIC),
          },
          402,
        );
      }

      const step1Result = await runStep1Checks(env, target, targetUrl, requesterId, url);
      if (step1Result) return step1Result;

      const cached = await getCached(env, target);
      if (cached) {
        const debit = await debitAccount(env, bearerApiKey, Number(CACHE_HIT_PRICE_ATOMIC));
        if (!debit.success) {
          return jsonResponse({ success: false, error: debit.reason }, 402);
        }
        logRequestCost({
          url: target,
          domain: targetUrl.hostname,
          cache_hit: true,
          layer: "L0",
          cost_actual_usd: 0.00001,
          charge_usd: 0.0002,
          latency_ms: Date.now() - requestStart,
          status: "success",
        });
        return jsonResponse(
          {
            success: true,
            markdown: cached.markdown,
            title: cached.metadata.title,
            cacheHit: true,
            tierUsed: cached.metadata.tierUsed,
            payment: { method: "credits", debitedAtomic: Number(CACHE_HIT_PRICE_ATOMIC), newBalanceAtomic: debit.newBalanceAtomic },
          },
          200,
        );
      }

      // Layer 1 pricing note: unlike Rail A (stuck with a pre-quoted
      // worst-case price), a credits debit is decided AFTER the outcome
      // is known - so a Bearer-billed request Layer 1 handles is charged
      // the real $0.002 "standard fetch" rate, not the $0.08 render rate.
      // This is the actual tiered-pricing win Rail B exists for.
      const layer1Result = await tryLayer1Fetch(target);
      if (layer1Result) {
        const debit = await debitAccount(env, bearerApiKey, Number(STANDARD_FETCH_PRICE_ATOMIC));
        if (!debit.success) {
          return jsonResponse({ success: false, error: debit.reason }, 402);
        }
        await setCached(env, target, { title: layer1Result.title, etag: null, tierUsed: "L1", markdown: layer1Result.markdown });
        logRequestCost({
          url: target,
          domain: targetUrl.hostname,
          cache_hit: false,
          layer: "L1",
          cost_actual_usd: 0.00002,
          charge_usd: 0.002,
          latency_ms: Date.now() - requestStart,
          status: "success",
        });
        return jsonResponse(
          {
            success: true,
            markdown: layer1Result.markdown,
            title: layer1Result.title,
            cacheHit: false,
            tierUsed: "L1",
            payment: { method: "credits", debitedAtomic: Number(STANDARD_FETCH_PRICE_ATOMIC), newBalanceAtomic: debit.newBalanceAtomic },
          },
          200,
        );
      }

      // Layer 1 also failed - enqueue for Layer 2/3. Debit is deferred to
      // the queue consumer (queue.ts), which knows the real tier used and
      // debits accordingly - including a $0.0001 charge on total failure,
      // which Rail A structurally can't do (see queue.ts).
      logRequestCost({
        url: target,
        domain: targetUrl.hostname,
        cache_hit: false,
        layer: "unresolved",
        cost_actual_usd: null,
        charge_usd: 0,
        latency_ms: Date.now() - requestStart,
        status: "pending",
      });
      const { jobId } = await enqueueRenderJob(env, target, { kind: "credits", apiKey: bearerApiKey });
      return jsonResponse(
        {
          success: true,
          status: "pending",
          jobId,
          pollUrl: `${JOB_STATUS_PATH_PREFIX}${jobId}`,
          note: "Queued for render. Poll pollUrl for status. Billed via credits once the real outcome is known.",
          payment: { method: "credits" },
        },
        202,
      );
    }

    // --- Rail A: x402 (Base Sepolia, scheme "exact"). Unchanged from
    // before Rail B existed, aside from now sharing runStep1Checks. ---
    if (!env.PAY_TO_ADDRESS) {
      return jsonResponse({ success: false, error: "PAYMENT_GATE_NOT_CONFIGURED" }, 500);
    }

    // --- Cache lookup happens BEFORE we quote a price. This is the real
    // reason it moved here rather than staying after Step 1: EIP-3009's
    // transferWithAuthorization signs an exact `value` - whatever price we
    // quote in the 402 is the only amount we can ever settle for this
    // request, so we need to know cache-hit-vs-miss before asking the
    // client to sign anything, not after. (This is a read-only lookup; it
    // doesn't serve any content yet, so there's no leak in checking it
    // pre-payment.) ---
    const cached = await getCached(env, target);

    const paymentRequirements = buildPaymentRequirements({
      resource: target,
      payTo: env.PAY_TO_ADDRESS,
      cacheHit: cached !== null,
    });

    const paymentHeader = request.headers.get("x-payment");
    if (!paymentHeader) {
      return jsonResponse(paymentRequiredBody(paymentRequirements, "X-PAYMENT header is required"), 402);
    }
    const paymentPayload = decodePaymentHeader(paymentHeader);
    if (!paymentPayload) {
      return jsonResponse(paymentRequiredBody(paymentRequirements, "X-PAYMENT header is malformed"), 400);
    }

    // Rate limit BEFORE the facilitator call, not after - the whole point
    // is to bound how often that outbound network call can be triggered.
    // Deliberately independent of target domain (see ratelimit.ts).
    const verifyLimit = await checkPaymentVerifyRateLimit(env, requesterId);
    if (verifyLimit.limited) {
      return jsonResponse({ success: false, error: "PAYMENT_VERIFY_RATE_LIMITED" }, 429);
    }

    const verification = await verifyPayment(paymentPayload, paymentRequirements);
    if (!verification.isValid) {
      return jsonResponse(
        paymentRequiredBody(paymentRequirements, `Payment invalid: ${verification.invalidReason ?? "unknown"}`),
        402,
      );
    }

    // --- Step 1 (Edge Safety). Runs after verification but before any
    // settlement - proves the client *can* pay before we do any work, but
    // a blocked/disallowed/rate-limited request is never actually charged. ---
    const step1Result = await runStep1Checks(env, target, targetUrl, requesterId, url);
    if (step1Result) return step1Result;

    // --- Layer 0 (cache, Step 5). Content is ready and the outcome is
    // known now, so settle synchronously - unlike a miss, there's no
    // async uncertainty to defer past. ---
    if (cached) {
      const settlement = await settlePayment(paymentPayload, paymentRequirements);
      if (!settlement.success) {
        // Payment Failed maps to 402 per the x402 HTTP transport spec.
        // Don't serve the cached content without payment actually landing.
        return jsonResponse(
          paymentRequiredBody(paymentRequirements, `Settlement failed: ${settlement.errorReason ?? "unknown"}`),
          402,
        );
      }
      logRequestCost({
        url: target,
        domain: targetUrl.hostname,
        cache_hit: true,
        layer: "L0",
        cost_actual_usd: 0.00001, // spec §4 Layer 0: ~$0.00001 cost
        charge_usd: 0.0002, // spec §5: cache tier price
        latency_ms: Date.now() - requestStart,
        status: "success",
      });
      return jsonResponse(
        {
          success: true,
          markdown: cached.markdown,
          title: cached.metadata.title,
          cacheHit: true,
          tierUsed: cached.metadata.tierUsed,
          payment: { verified: true, settled: true, transaction: settlement.transaction, payer: settlement.payer },
        },
        200,
      );
    }

    // --- Cache miss. Layer 1: try a cheap, direct in-Worker fetch before
    // falling back to the paid Layer 2/3 render pipeline. Deliberately
    // attempted here - after payment is verified and Step 1 has passed -
    // not as a pre-payment price probe. See layer1.ts for the full
    // reasoning (short version: probing pre-payment would mean an
    // unauthenticated request can make Quikgater fetch an arbitrary
    // third-party page for free, and EIP-3009's exact-signed-amount means
    // the client is still charged the quoted miss price either way - this
    // saves real provider cost and latency on our end, it doesn't yet pass
    // a cheaper price through to the client). Rail B above does pass the
    // savings through, since it has no equivalent signature constraint. ---
    const layer1Result = await tryLayer1Fetch(target);
    if (layer1Result) {
      const settlement = await settlePayment(paymentPayload, paymentRequirements);
      if (!settlement.success) {
        return jsonResponse(
          paymentRequiredBody(paymentRequirements, `Settlement failed: ${settlement.errorReason ?? "unknown"}`),
          402,
        );
      }
      await setCached(env, target, {
        title: layer1Result.title,
        etag: null,
        tierUsed: "L1",
        markdown: layer1Result.markdown,
      });
      logRequestCost({
        url: target,
        domain: targetUrl.hostname,
        cache_hit: false,
        layer: "L1",
        cost_actual_usd: 0.00002, // just Worker CPU + one outbound fetch, no paid provider call
        charge_usd: 0.08, // still the quoted miss price - see layer1.ts on why this isn't the cheaper tier yet
        latency_ms: Date.now() - requestStart,
        status: "success",
      });
      return jsonResponse(
        {
          success: true,
          markdown: layer1Result.markdown,
          title: layer1Result.title,
          cacheHit: false,
          tierUsed: "L1",
          payment: { verified: true, settled: true, transaction: settlement.transaction, payer: settlement.payer },
        },
        200,
      );
    }

    // Layer 1 also failed (network error, timeout, JS-shell SPA, or an
    // active bot challenge) - fall back to Step 4's async render queue
    // (Layer 2/3), exactly as before Layer 1 existed.
    //
    // Settlement is deliberately DEFERRED, not skipped: the queue consumer
    // (processRenderJob) settles this exact authorization once it knows
    // the outcome - only if the render actually succeeds. If every
    // provider fails, settlePayment is never called at all: the signed
    // authorization simply expires unused and the client is never charged.
    // That's the only clean way to do "don't charge for nothing" under
    // EIP-3009's exact-amount model - there's no partial-settle. ---
    logRequestCost({
      url: target,
      domain: targetUrl.hostname,
      cache_hit: false,
      layer: "unresolved", // real layer isn't known until the queue consumer resolves it
      cost_actual_usd: null,
      charge_usd: 0.08, // MISS_PRICE_ATOMIC - only settled if the render succeeds
      latency_ms: Date.now() - requestStart,
      status: "pending",
    });
    const { jobId } = await enqueueRenderJob(env, target, { kind: "x402", paymentPayload, paymentRequirements });
    return jsonResponse(
      {
        success: true,
        status: "pending",
        jobId,
        pollUrl: `${JOB_STATUS_PATH_PREFIX}${jobId}`,
        note: "Queued for render. Poll pollUrl for status. Payment verified but settlement is deferred until the render succeeds - you are not charged if it fails.",
        payment: { verified: true, settled: false, payer: verification.payer },
      },
      202,
    );
  },

  async queue(batch: MessageBatch<RenderJob>, env: Env, _ctx: ExecutionContext): Promise<void> {
    for (const message of batch.messages) {
      try {
        await processRenderJob(env, message.body);
        message.ack();
      } catch (e) {
        console.error(JSON.stringify({ event: "render_job_failed", jobId: message.body.jobId, error: String(e) }));
        message.retry();
      }
    }
  },
};
