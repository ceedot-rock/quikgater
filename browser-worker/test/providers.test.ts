import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as browserbase from "../src/providers/browserbase.js";
import * as steeldev from "../src/providers/steeldev.js";
import * as firecrawl from "../src/providers/firecrawl.js";
import * as scraperapi from "../src/providers/scraperapi.js";

const originalEnv = { ...process.env };
const originalFetch = global.fetch;

beforeEach(() => {
  process.env = { ...originalEnv };
});

afterEach(() => {
  process.env = { ...originalEnv };
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("browserbase.render", () => {
  it("throws without BROWSERBASE_API_KEY configured, without making a network call", async () => {
    delete process.env.BROWSERBASE_API_KEY;
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    await expect(browserbase.render("https://example.com")).rejects.toThrow("BROWSERBASE_API_KEY");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("calls the real Fetch API endpoint with the documented shape and returns markdown", async () => {
    process.env.BROWSERBASE_API_KEY = "test-key";
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.browserbase.com/v1/fetch");
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>)["X-BB-API-Key"]).toBe("test-key");
      expect(JSON.parse(init?.body as string)).toEqual({ url: "https://example.com", format: "markdown" });
      return new Response(
        JSON.stringify({ statusCode: 200, content: "# Hello", contentType: "text/markdown" }),
        { status: 200 },
      );
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const result = await browserbase.render("https://example.com");
    expect(result).toEqual({ markdown: "# Hello", providerUsed: "browserbase", costActual: null });
  });

  it("throws on a non-ok response", async () => {
    process.env.BROWSERBASE_API_KEY = "test-key";
    global.fetch = vi.fn(async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;

    await expect(browserbase.render("https://example.com")).rejects.toThrow("browserbase fetch failed: 401");
  });

  it("throws when the response has no content", async () => {
    process.env.BROWSERBASE_API_KEY = "test-key";
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify({ statusCode: 200, content: "" }), { status: 200 }),
    ) as unknown as typeof fetch;

    await expect(browserbase.render("https://example.com")).rejects.toThrow("no content");
  });
});

describe("steeldev.render", () => {
  it("throws without STEEL_API_KEY configured, without making a network call", async () => {
    delete process.env.STEEL_API_KEY;
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    await expect(steeldev.render("https://example.com")).rejects.toThrow("STEEL_API_KEY");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("calls the real scrape endpoint with the documented shape and returns markdown", async () => {
    process.env.STEEL_API_KEY = "test-key";
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.steel.dev/v1/scrape");
      expect((init?.headers as Record<string, string>)["steel-api-key"]).toBe("test-key");
      expect(JSON.parse(init?.body as string)).toEqual({ url: "https://example.com", format: ["markdown"] });
      return new Response(
        JSON.stringify({ content: { markdown: "# Steel Content" }, links: [], metadata: { statusCode: 200 } }),
        { status: 200 },
      );
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const result = await steeldev.render("https://example.com");
    expect(result).toEqual({ markdown: "# Steel Content", providerUsed: "steeldev", costActual: null });
  });

  it("throws when content.markdown is missing", async () => {
    process.env.STEEL_API_KEY = "test-key";
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify({ content: {}, links: [], metadata: {} }), { status: 200 }),
    ) as unknown as typeof fetch;

    await expect(steeldev.render("https://example.com")).rejects.toThrow("no markdown content");
  });
});

describe("firecrawl.scrape", () => {
  it("throws without FIRECRAWL_API_KEY configured, without making a network call", async () => {
    delete process.env.FIRECRAWL_API_KEY;
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    await expect(firecrawl.scrape("https://example.com")).rejects.toThrow("FIRECRAWL_API_KEY");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("calls the real v2 scrape endpoint with Bearer auth and returns markdown", async () => {
    process.env.FIRECRAWL_API_KEY = "test-key";
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.firecrawl.dev/v2/scrape");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer test-key");
      expect(JSON.parse(init?.body as string)).toEqual({ url: "https://example.com", formats: ["markdown"] });
      return new Response(
        JSON.stringify({ success: true, data: { markdown: "# Firecrawl Content" } }),
        { status: 200 },
      );
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const result = await firecrawl.scrape("https://example.com");
    expect(result).toEqual({ markdown: "# Firecrawl Content", providerUsed: "firecrawl", costActual: null });
  });

  it("throws when success is false", async () => {
    process.env.FIRECRAWL_API_KEY = "test-key";
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify({ success: false }), { status: 200 }),
    ) as unknown as typeof fetch;

    await expect(firecrawl.scrape("https://example.com")).rejects.toThrow("no markdown content");
  });
});

describe("scraperapi.scrape", () => {
  it("throws without SCRAPERAPI_KEY configured, without making a network call", async () => {
    delete process.env.SCRAPERAPI_KEY;
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    await expect(scraperapi.scrape("https://example.com")).rejects.toThrow("SCRAPERAPI_KEY");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("calls the real endpoint with render+ultra_premium and converts the HTML response to markdown", async () => {
    process.env.SCRAPERAPI_KEY = "test-key";
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const requestUrl = new URL(String(input));
      expect(requestUrl.origin + requestUrl.pathname).toBe("https://api.scraperapi.com/");
      expect(requestUrl.searchParams.get("api_key")).toBe("test-key");
      expect(requestUrl.searchParams.get("url")).toBe("https://example.com");
      expect(requestUrl.searchParams.get("render")).toBe("true");
      expect(requestUrl.searchParams.get("ultra_premium")).toBe("true");
      return new Response("<html><body><h1>Hi</h1><p>Real content.</p></body></html>", { status: 200 });
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const result = await scraperapi.scrape("https://example.com");
    expect(result.provider).toBe("scraperapi");
    expect(result.costActual).toBeNull();
    expect(result.markdown).toContain("# Hi");
    expect(result.markdown).toContain("Real content.");
  });

  it("throws on a non-ok response", async () => {
    process.env.SCRAPERAPI_KEY = "test-key";
    global.fetch = vi.fn(async () => new Response("blocked", { status: 403 })) as unknown as typeof fetch;

    await expect(scraperapi.scrape("https://example.com")).rejects.toThrow("scraperapi request failed: 403");
  });
});
