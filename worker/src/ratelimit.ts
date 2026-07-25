import type { Env } from "./env";

// Spec §2, check 3: "same requester >100 req/min to same domain = 429".
const DOMAIN_WINDOW_SECONDS = 60;
const DOMAIN_LIMIT = 100;

// Payment verification hits the real x402 facilitator over the network -
// a meaningfully more expensive and more abusable call than an in-Worker
// check (unbounded calls could exhaust facilitator rate limits or, once
// a paid mainnet facilitator is in the picture, cost real money). Unlike
// the per-domain limiter above, this must be keyed on the requester ONLY:
// it runs before the target domain has cleared the blocklist, and a
// requester who rotates target domains per request would otherwise dodge
// the domain-scoped limit entirely while still hammering the facilitator
// on every single request.
//
// Every request needs its own payment verification (no session/caching
// of a verified payment), so a legitimate client running near the
// domain limiter's 100 req/min ceiling - or spread across several
// domains - needs real headroom above 100 here. This is a backstop
// against pathological abuse (thousands of garbage-payload requests to
// force facilitator calls), not a throttle on normal multi-domain usage.
const VERIFY_WINDOW_SECONDS = 60;
const VERIFY_LIMIT = 300;

/**
 * Approximate fixed-window rate limiter backed by KV.
 *
 * KV is eventually consistent and this does a read-then-write (not an
 * atomic increment), so concurrent requests in the same window can
 * under-count. That's an accepted tradeoff for Step 1 - this is an abuse
 * backstop, not a billing-accurate counter (billing/cost tracking is
 * Step 5, via Tinybird). If exact counts matter, replace with a Durable
 * Object per bucket key.
 */
async function incrementWindowCounter(
  kv: KVNamespace,
  key: string,
  windowSeconds: number,
): Promise<number> {
  const current = await kv.get(key);
  const count = current ? parseInt(current, 10) + 1 : 1;

  await kv.put(key, String(count), {
    expirationTtl: windowSeconds * 2, // outlive the window so late reads still see it
  });

  return count;
}

/**
 * Per (requester, domain) fetch-pipeline limiter - spec §2 check 3.
 * `isPro` doubles the ceiling (Quikgater Pro's "2x rate limit" perk, see
 * credits.ts's isProActive) - only ever true for a Bearer-authenticated
 * request whose account has an active Pro subscription; x402/free-tier
 * callers have no account to check Pro status against, so they always get
 * the base limit.
 */
export async function checkRateLimit(
  env: Env,
  requesterId: string,
  domain: string,
  isPro = false,
): Promise<{ limited: boolean; count: number }> {
  const windowBucket = Math.floor(Date.now() / 1000 / DOMAIN_WINDOW_SECONDS);
  const key = `rl:${requesterId}:${domain}:${windowBucket}`;
  const count = await incrementWindowCounter(env.RATELIMIT_KV, key, DOMAIN_WINDOW_SECONDS);
  const limit = isPro ? DOMAIN_LIMIT * 2 : DOMAIN_LIMIT;
  return { limited: count > limit, count };
}

/** Per-requester limiter guarding the outbound facilitator /verify call. */
export async function checkPaymentVerifyRateLimit(
  env: Env,
  requesterId: string,
): Promise<{ limited: boolean; count: number }> {
  const windowBucket = Math.floor(Date.now() / 1000 / VERIFY_WINDOW_SECONDS);
  const key = `rl-verify:${requesterId}:${windowBucket}`;
  const count = await incrementWindowCounter(env.RATELIMIT_KV, key, VERIFY_WINDOW_SECONDS);
  return { limited: count > VERIFY_LIMIT, count };
}

// Free tier ("100 free cache hits/day/IP", per the README's gap note): a
// cache hit is cheap enough to serve without touching either payment rail
// at all. Fixed-window like the limiters above, just a 24h window instead
// of 60s, and keyed by IP only - see index.ts for why (Bearer-authenticated
// callers already have a paid account and don't get a competing free
// allowance, and the spec explicitly scopes this quota by IP, not by
// requesterId's x-api-key-first fallback). Distinct "free:" prefix so it
// can never collide with the rl:/rl-verify: keys above.
const FREE_TIER_WINDOW_SECONDS = 24 * 60 * 60;
export const FREE_TIER_DAILY_LIMIT = 100;

/**
 * Per-IP daily free-cache-hit quota. Only call this once a cache hit is
 * already confirmed - it increments on every call, and the free tier is
 * only ever meant to cover hits (a miss always falls through to a paid
 * rail regardless of quota, per index.ts).
 */
export async function checkFreeTierQuota(env: Env, ip: string): Promise<{ limited: boolean; count: number }> {
  const dayBucket = Math.floor(Date.now() / 1000 / FREE_TIER_WINDOW_SECONDS);
  const key = `free:${ip}:${dayBucket}`;
  const count = await incrementWindowCounter(env.RATELIMIT_KV, key, FREE_TIER_WINDOW_SECONDS);
  return { limited: count > FREE_TIER_DAILY_LIMIT, count };
}
