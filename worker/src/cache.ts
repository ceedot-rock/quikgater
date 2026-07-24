import type { Env } from "./env";

// Step 5: Cache + Cost Tracking (spec §4 Layer 0, §8). KV holds metadata
// (title, etag, timestamp, tier used), R2 holds the markdown body -
// exactly the split the spec calls for.

export const DEFAULT_RENDER_MODE = "markdown"; // only mode this build produces

/**
 * Render results (browser-worker's /render, /hard-fallback) don't carry a
 * title field - that'd need real HTML parsing on the Fly.io side, which
 * isn't built (Step 6). Falls back to the first Markdown heading, then
 * the URL itself, rather than leaving metadata.title empty.
 */
export function deriveTitle(markdown: string, url: string): string {
  const heading = markdown.match(/^#{1,6}\s+(.+)$/m);
  return heading?.[1]?.trim() || url;
}

export interface CacheMetadata {
  title: string;
  etag: string | null;
  cachedAt: number;
  tierUsed: string; // e.g. "L2-browserbase", "L3"
  ttlTier: TtlTier;
}

export interface CacheEntry {
  metadata: CacheMetadata;
  markdown: string;
}

/**
 * Normalizes a URL for cache-key purposes: lowercase host, drop default
 * ports, drop the fragment, strip a trailing slash (except root), sort
 * query params. Two URLs that are "the same page" with different query
 * param order or a stray trailing slash should hit the same cache entry.
 */
export function normalizeUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
    url.port = "";
  }
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }
  url.searchParams.sort();
  return url.toString();
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function cacheKey(normalizedUrl: string, renderMode: string): Promise<string> {
  return sha256Hex(`${normalizedUrl}::${renderMode}`);
}

export type TtlTier = "docs" | "blogs" | "news" | "product" | "default";

// Static map per spec §4 Layer 0 ("Start with static map"). This is a
// rough URL-shape heuristic, not real content classification - it has no
// signal from the page itself (title, meta tags, actual publish
// frequency). Revisit once there's real cache-hit-rate data to tune
// against; right now it's a reasonable starting guess, not a measured one.
const TTL_SECONDS_BY_TIER: Record<TtlTier, number> = {
  docs: 24 * 60 * 60,
  blogs: 6 * 60 * 60,
  news: 5 * 60,
  product: 60 * 60,
  default: 60 * 60,
};

export function classifyTtl(url: URL): { tier: TtlTier; ttlSeconds: number } {
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();

  let tier: TtlTier = "default";
  if (host.startsWith("docs.") || path.includes("/docs/") || path.includes("/documentation/")) {
    tier = "docs";
  } else if (host.includes("news") || path.includes("/news/") || path.includes("/article/")) {
    tier = "news";
  } else if (host.includes("blog") || path.includes("/blog/") || path.includes("/posts/")) {
    tier = "blogs";
  } else if (path.includes("/product/") || path.includes("/p/") || path.includes("/item/")) {
    tier = "product";
  }

  return { tier, ttlSeconds: TTL_SECONDS_BY_TIER[tier] };
}

function kvKey(hash: string): string {
  return `cache:${hash}`;
}

function r2Key(hash: string): string {
  return `cache/${hash}`;
}

export async function getCached(
  env: Env,
  url: string,
  renderMode: string = DEFAULT_RENDER_MODE,
): Promise<CacheEntry | null> {
  const hash = await cacheKey(normalizeUrl(url), renderMode);

  const metaRaw = await env.CACHE_KV.get(kvKey(hash));
  if (!metaRaw) return null;

  const body = await env.CACHE_R2.get(r2Key(hash));
  if (!body) {
    // KV pointer survived past its R2 body (e.g. R2 write failed after
    // the KV write succeeded) - treat as a miss rather than serving a
    // metadata-only response with no content.
    console.log(JSON.stringify({ event: "cache_inconsistent", hash, reason: "kv_present_r2_missing" }));
    return null;
  }

  const metadata = JSON.parse(metaRaw) as CacheMetadata;
  return { metadata, markdown: await body.text() };
}

export interface SetCacheInput {
  title: string;
  etag: string | null;
  tierUsed: string;
  markdown: string;
}

export async function setCached(
  env: Env,
  url: string,
  input: SetCacheInput,
  renderMode: string = DEFAULT_RENDER_MODE,
): Promise<void> {
  const normalized = normalizeUrl(url);
  const hash = await cacheKey(normalized, renderMode);
  const { tier, ttlSeconds } = classifyTtl(new URL(normalized));

  const metadata: CacheMetadata = {
    title: input.title,
    etag: input.etag,
    cachedAt: Date.now(),
    tierUsed: input.tierUsed,
    ttlTier: tier,
  };

  // R2 has no TTL of its own - the KV pointer expiring is what makes an
  // entry effectively invisible to getCached, but the R2 object itself
  // will outlive it as an orphan until something cleans up. Fine at this
  // scale; add an R2 lifecycle rule (or a sweep job keyed off KV's expiry
  // events) before this matters in practice.
  await env.CACHE_R2.put(r2Key(hash), input.markdown);
  await env.CACHE_KV.put(kvKey(hash), JSON.stringify(metadata), { expirationTtl: ttlSeconds });
}
