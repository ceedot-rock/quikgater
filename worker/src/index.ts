import type { Env } from "./env";
import { isBlocklisted } from "./blocklist";
import { getRobotsTxt, robotsAllows } from "./robots";
import { checkFreeTierQuota, checkPaymentVerifyRateLimit, checkRateLimit, FREE_TIER_DAILY_LIMIT } from "./ratelimit";
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
import { getCached, setCached, PRO_CACHE_TTL_SECONDS } from "./cache";
import { logRequestCost } from "./costlog";
import { buildPublicCostsBody } from "./publicCosts";
import { tryLayer1Fetch } from "./layer1";
import { createAccount, creditAccount, debitAccount, generateApiKey, getAccount, isProActive, setProStatus } from "./credits";
import {
  createDepositCheckoutSession,
  createProSubscriptionCheckoutSession,
  isValidDepositAmount,
  parseCheckoutCompletedEvent,
  parseSubscriptionCheckoutCompletedEvent,
  parseSubscriptionStatusEvent,
  verifyWebhookSignature,
} from "./stripe";

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const JOB_STATUS_PATH_PREFIX = "/v1/job/";
