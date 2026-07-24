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
} from "./payment";
import { enqueueRenderJob, getJobStatus, processRenderJob, type RenderJob } from "./queue";
import { getCached } from "./cache";
import { logRequestCost } from "./costlog";

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const JOB_STATUS_PATH_PREFIX = "/v1/job/";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const requestStart = Date.now();
    const url = new URL(request.url);

    // Job status polling (spec §8 Step 4: "GET /v1/job/{id}"). Handled
    // before anything else - it's a status lookup for a job that was
    // already paid for and queued, not a new fetch request, so it
    // shouldn't go through the payment gate or Step 1 checks again.
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

    // Extracted early because both the payment-verify limiter and the
    // Step 1 domain limiter below need it.
    const requesterId =
      request.headers.get("x-api-key") ?? request.headers.get("cf-connecting-ip") ?? "anonymous";

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

    // --- Payment gate (x402, Base Sepolia, scheme "exact"). Only the x402
    // rail is implemented - Bearer/deposit-credits (spec §5 Rail B) is a
    // separate subsystem (Stripe, auto-topup) that isn't built. Free-tier
    // bypass isn't implemented either: it's specifically "100 free cache
    // hits/day/IP", which needs an account/IP-quota system this doesn't
    // have - a cache hit is cheap to serve but still requires payment. ---
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

    // Check 1: blocklist (static HARD_BLOCKLIST + dynamic KV paywall list)
    const dynamicListRaw = await env.BLOCKLIST_KV.get("dynamic-blocklist:json");
    const dynamicPatterns: string[] = dynamicListRaw ? JSON.parse(dynamicListRaw) : [];
    const blockResult = isBlocklisted(targetUrl.hostname, dynamicPatterns);
    if (blockResult.blocked) {
      // No x402 settle on a block, per spec §2.
      return jsonResponse({ success: false, error: "BLOCKED_LEGAL_RISK", cost: 0 }, 403);
    }

    // Check 2: robots.txt (default respect; ?ignore_robots=true bypasses,
    // but is logged and still subject to the same rate limit below)
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

    // Check 3: abuse rate limit (100 req/min/domain per requester)
    const { limited } = await checkRateLimit(env, requesterId, targetUrl.hostname);
    if (limited) {
      return jsonResponse({ success: false, error: "RATE_LIMITED" }, 429);
    }

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

    // --- Cache miss. Layer 1 (free in-Worker fetch, not built and not
    // one of the 6 numbered steps) doesn't exist, so unlike the spec's
    // real design there's no cheaper layer to try before the queue - a
    // miss goes straight to Step 4's async queue. See queue.ts.
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
    const { jobId } = await enqueueRenderJob(env, target, paymentPayload, paymentRequirements);
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
