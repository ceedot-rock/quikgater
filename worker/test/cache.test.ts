import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  cacheKey,
  classifyTtl,
  deriveTitle,
  getCached,
  normalizeUrl,
  PRO_CACHE_TTL_SECONDS,
  setCached,
} from "../src/cache";
import type { Env } from "../src/env";

describe("normalizeUrl", () => {
  it("lowercases the hostname", () => {
    expect(normalizeUrl("https://EXAMPLE.com/page")).toBe("https://example.com/page");
  });

  it("strips a trailing slash, but not from the root path", () => {
    expect(normalizeUrl("https://example.com/page/")).toBe("https://example.com/page");
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com/");
  });

  it("strips the fragment", () => {
    expect(normalizeUrl("https://example.com/page#section")).toBe("https://example.com/page");
  });

  it("strips default ports", () => {
    expect(normalizeUrl("https://example.com:443/page")).toBe("https://example.com/page");
    expect(normalizeUrl("http://example.com:80/page")).toBe("http://example.com/page");
  });

  it("sorts query params so order doesn't matter", () => {
    expect(normalizeUrl("https://example.com/page?b=2&a=1")).toBe(
      normalizeUrl("https://example.com/page?a=1&b=2"),
    );
  });
});

describe("cacheKey", () => {
  it("is deterministic for the same normalized url + render mode", async () => {
    const a = await cacheKey("https://example.com/page", "markdown");
    const b = await cacheKey("https://example.com/page", "markdown");
    expect(a).toBe(b);
  });

  it("differs for different render modes on the same url", async () => {
    const a = await cacheKey("https://example.com/page", "markdown");
    const b = await cacheKey("https://example.com/page", "html");
    expect(a).not.toBe(b);
  });

  it("differs for different urls", async () => {
    const a = await cacheKey("https://example.com/a", "markdown");
    const b = await cacheKey("https://example.com/b", "markdown");
    expect(a).not.toBe(b);
  });

  it("produces a 64-char hex sha256 digest", async () => {
    const key = await cacheKey("https://example.com/page", "markdown");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("classifyTtl", () => {
  it("classifies docs.* subdomains and /docs/ paths as docs (24h)", () => {
    expect(classifyTtl(new URL("https://docs.stripe.com/api")).tier).toBe("docs");
    expect(classifyTtl(new URL("https://example.com/docs/guide")).tier).toBe("docs");
    expect(classifyTtl(new URL("https://docs.stripe.com/api")).ttlSeconds).toBe(86400);
  });

  it("classifies blog paths/hosts as blogs (6h)", () => {
    expect(classifyTtl(new URL("https://blog.example.com/post")).tier).toBe("blogs");
    expect(classifyTtl(new URL("https://example.com/blog/post")).ttlSeconds).toBe(21600);
  });

  it("classifies news paths/hosts as news (5m)", () => {
    expect(classifyTtl(new URL("https://news.example.com/story")).tier).toBe("news");
    expect(classifyTtl(new URL("https://example.com/article/1")).ttlSeconds).toBe(300);
  });

  it("classifies product paths as product (1h)", () => {
    expect(classifyTtl(new URL("https://shop.example.com/product/widget")).tier).toBe("product");
  });

  it("falls back to default (1h) for anything unrecognized", () => {
    const { tier, ttlSeconds } = classifyTtl(new URL("https://example.com/whatever"));
    expect(tier).toBe("default");
    expect(ttlSeconds).toBe(3600);
  });
});

describe("deriveTitle", () => {
  it("extracts the first markdown heading", () => {
    expect(deriveTitle("# My Title\n\nBody text", "https://example.com")).toBe("My Title");
  });

  it("falls back to the url when there's no heading", () => {
    expect(deriveTitle("just some text, no heading", "https://example.com/page")).toBe(
      "https://example.com/page",
    );
  });
});

describe("getCached / setCached", () => {
  it("returns null for a url that was never cached", async () => {
    const result = await getCached(env as Env, "https://never-cached.example/page");
    expect(result).toBeNull();
  });

  it("round-trips a cache entry", async () => {
    const url = "https://roundtrip.example/docs/guide";
    await setCached(env as Env, url, {
      title: "Guide",
      etag: null,
      tierUsed: "L2-browserbase",
      markdown: "# Guide\n\nContent here.",
    });

    const result = await getCached(env as Env, url);
    expect(result).not.toBeNull();
    expect(result?.markdown).toBe("# Guide\n\nContent here.");
    expect(result?.metadata).toMatchObject({ title: "Guide", tierUsed: "L2-browserbase", ttlTier: "docs" });
  });

  it("treats URLs that only differ by query-param order or trailing slash as the same entry", async () => {
    const url = "https://normalize-test.example/page/";
    await setCached(env as Env, url, { title: "T", etag: null, tierUsed: "L3", markdown: "# T" });

    const result = await getCached(env as Env, "https://NORMALIZE-TEST.example/page");
    expect(result?.markdown).toBe("# T");
  });

  it("treats a KV-present/R2-missing entry as a miss rather than erroring", async () => {
    const url = "https://inconsistent.example/page";
    const hash = await cacheKey(normalizeUrl(url), "markdown");
    // Simulate a partial write: metadata landed, body didn't.
    await env.CACHE_KV.put(`cache:${hash}`, JSON.stringify({ title: "T", etag: null, cachedAt: Date.now(), tierUsed: "L3", ttlTier: "default" }));

    const result = await getCached(env as Env, url);
    expect(result).toBeNull();
  });

  it("applies the Pro TTL floor when it's longer than the URL-shape tier's own TTL", async () => {
    const url = "https://pro-floor-news.example/news/breaking-story";
    const hash = await cacheKey(normalizeUrl(url), "markdown");
    // news' own tier TTL is only 300s (see classifyTtl) - the Pro floor
    // (7 days) should win, since it's the longer of the two.
    await setCached(env as Env, url, { title: "T", etag: null, tierUsed: "L2-browserbase", markdown: "# T" }, undefined, PRO_CACHE_TTL_SECONDS);

    const list = await env.CACHE_KV.list({ prefix: `cache:${hash}` });
    const entry = list.keys[0];
    expect(entry?.expiration).toBeDefined();
    const secondsFromNow = (entry!.expiration as number) - Math.floor(Date.now() / 1000);
    // Allow slack for test execution time, but this should be close to 7
    // days out, not classifyTtl's 300s for a "news" URL.
    expect(secondsFromNow).toBeGreaterThan(PRO_CACHE_TTL_SECONDS - 60);
  });

  it("does not shorten a tier's own longer TTL when the Pro floor is smaller (docs' 24h already exceeds it in this hypothetical)", async () => {
    // Sanity check on the Math.max semantics: floor never shortens
    // whatever classifyTtl would have picked on its own.
    const url = "https://pro-floor-docs.example/docs/guide";
    const hash = await cacheKey(normalizeUrl(url), "markdown");
    const shortFloor = 60; // shorter than docs' own 24h tier TTL
    await setCached(env as Env, url, { title: "T", etag: null, tierUsed: "L2-browserbase", markdown: "# T" }, undefined, shortFloor);

    const list = await env.CACHE_KV.list({ prefix: `cache:${hash}` });
    const entry = list.keys[0];
    const secondsFromNow = (entry!.expiration as number) - Math.floor(Date.now() / 1000);
    expect(secondsFromNow).toBeGreaterThan(24 * 60 * 60 - 60); // still ~24h, not 60s
  });
});
