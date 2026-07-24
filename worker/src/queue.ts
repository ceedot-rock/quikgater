import type { Env } from "./env";
import { deriveTitle, setCached } from "./cache";
import { logRequestCost } from "./costlog";
import type { CostLogEntry } from "./costlog";
import { settlePayment } from "./payment";
import type { PaymentPayload, PaymentRequirements } from "./payment";

// Step 4: Async Queue (spec §3, §8). "Worker no longer calls Fly.io
// synchronously. v1's sync call caused timeouts. Now async via Queue.
// Worker returns 202 ... with job_id for polling."
//
// Scope note: the spec reserves the queue for requests that miss Layer 0
// (cache, Step 5) AND fail Layer 1 (free in-Worker fetch - not built,
// not one of the 6 numbered steps either). Neither exists yet, so right
// now EVERY request that clears the Step 1 shield goes straight to the
// queue - there's no cheaper layer in front of it to skip. That's more
// expensive than the spec's real design, not a bug in this wiring; note
// it in the README rather than fake a Layer 1 that isn't built.

export interface RenderJob {
  jobId: string;
  url: string;
  attempt: number;
  requestedAt: number;
  // Carried through so processRenderJob can settle this exact signed
  // authorization once (and only if) the render actually succeeds - see
  // payment.ts for why settlement can't just charge a different amount
  // after the fact.
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
}

export type JobStatus =
  | { status: "pending" }
  | {
      status: "done";
      markdown: string;
      providerUsed: string;
      completedAt: number;
      settled: boolean;
      transaction?: string;
      settlementError?: string;
    }
  | { status: "failed"; error: string; completedAt: number };

const JOB_TTL_SECONDS = 60 * 60; // 1h polling window - not a cache, just bounds KV growth

function jobKey(jobId: string): string {
  return `job:${jobId}`;
}

export async function enqueueRenderJob(
  env: Env,
  url: string,
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
): Promise<{ jobId: string }> {
  const jobId = crypto.randomUUID();
  const job: RenderJob = {
    jobId,
    url,
    attempt: 1,
    requestedAt: Date.now(),
    paymentPayload,
    paymentRequirements,
  };

  // Write "pending" before sending, so a poll that lands between these
  // two calls sees a real (if incomplete) status instead of 404.
  await env.JOBS_KV.put(jobKey(jobId), JSON.stringify({ status: "pending" } satisfies JobStatus), {
    expirationTtl: JOB_TTL_SECONDS,
  });
  await env.RENDER_QUEUE.send(job);

  return { jobId };
}

export async function getJobStatus(env: Env, jobId: string): Promise<JobStatus | null> {
  const raw = await env.JOBS_KV.get(jobKey(jobId));
  return raw ? (JSON.parse(raw) as JobStatus) : null;
}

async function writeJobStatus(env: Env, jobId: string, status: JobStatus): Promise<void> {
  await env.JOBS_KV.put(jobKey(jobId), JSON.stringify(status), { expirationTtl: JOB_TTL_SECONDS });
}

function layerForProvider(providerUsed: string): CostLogEntry["layer"] {
  if (providerUsed === "browserbase") return "L2-browserbase";
  if (providerUsed === "steeldev") return "L2-steel";
  if (providerUsed === "firecrawl") return "L2-firecrawl";
  return "L2";
}

/**
 * Settles the job's authorization now that content is ready, and writes
 * the final job status either way.
 *
 * If settlement fails despite the render succeeding (expired
 * authorization, facilitator error, etc.) - a real edge case, not
 * swallowed - the content is still returned to the client (it was
 * already rendered; withholding it doesn't get anyone paid), but
 * `settled: false` and `settlementError` make the failure visible to
 * whoever's watching job status or cost logs, since it means the
 * provider cost was paid but the client wasn't charged.
 */
async function settleAndWriteDone(
  env: Env,
  job: RenderJob,
  result: { markdown: string; providerUsed: string; tierUsed: CostLogEntry["layer"]; costActual: number | null },
  domain: string,
  start: number,
): Promise<void> {
  const settlement = await settlePayment(job.paymentPayload, job.paymentRequirements);

  await writeJobStatus(env, job.jobId, {
    status: "done",
    markdown: result.markdown,
    providerUsed: result.providerUsed,
    completedAt: Date.now(),
    settled: settlement.success,
    ...(settlement.success ? { transaction: settlement.transaction } : { settlementError: settlement.errorReason }),
  });

  await setCached(env, job.url, {
    title: deriveTitle(result.markdown, job.url),
    etag: null,
    tierUsed: result.tierUsed,
    markdown: result.markdown,
  });

  logRequestCost({
    url: job.url,
    domain,
    cache_hit: false,
    layer: result.tierUsed,
    cost_actual_usd: result.costActual,
    charge_usd: settlement.success ? 0.08 : 0,
    latency_ms: Date.now() - start,
    status: settlement.success ? "success" : "failed",
    ...(settlement.success ? {} : { provider_error: `content rendered but settlement failed: ${settlement.errorReason ?? "unknown"}` }),
  });
}

/**
 * Consumer-side logic: POST /render, and on failure POST /hard-fallback,
 * against quikgater-browser-worker. Matches the failover-orchestrator
 * shape from spec §3's diagram ("if fail -> POST /hard-fallback").
 *
 * Settlement only happens here, and only on success - see payment.ts and
 * settleAndWriteDone above for why. On total failure (every provider AND
 * hard-fallback fail), settlePayment is never called at all: the client's
 * signed authorization simply expires unused, so they're never charged
 * for a render that never delivered anything.
 */
export async function processRenderJob(env: Env, job: RenderJob, fetchImpl: typeof fetch = fetch): Promise<void> {
  const start = Date.now();
  const domain = new URL(job.url).hostname;

  const renderRes = await fetchImpl(`${env.BROWSER_WORKER_URL}/render`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: job.url, attempt: job.attempt }),
  });

  if (renderRes.ok) {
    const body = (await renderRes.json()) as { markdown: string; providerUsed: string; costActual?: number };
    await settleAndWriteDone(
      env,
      job,
      {
        markdown: body.markdown,
        providerUsed: body.providerUsed,
        tierUsed: layerForProvider(body.providerUsed),
        costActual: body.costActual ?? null,
      },
      domain,
      start,
    );
    return;
  }

  const fallbackRes = await fetchImpl(`${env.BROWSER_WORKER_URL}/hard-fallback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: job.url, reason: "layer2_failed" }),
  });

  if (fallbackRes.ok) {
    const body = (await fallbackRes.json()) as { markdown: string; provider: string; costActual?: number };
    await settleAndWriteDone(
      env,
      job,
      { markdown: body.markdown, providerUsed: body.provider, tierUsed: "L3", costActual: body.costActual ?? null },
      domain,
      start,
    );
    return;
  }

  // Total failure - never settle. The client's authorization simply
  // expires unused; they are not charged.
  await writeJobStatus(env, job.jobId, { status: "failed", error: "RENDER_FAILED", completedAt: Date.now() });
  logRequestCost({
    url: job.url,
    domain,
    cache_hit: false,
    layer: "L3",
    cost_actual_usd: null,
    charge_usd: 0,
    latency_ms: Date.now() - start,
    status: "failed",
    provider_error: "RENDER_FAILED",
  });
}
