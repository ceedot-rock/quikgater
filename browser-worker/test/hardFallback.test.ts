import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/providers/scraperapi.js", () => ({ scrape: vi.fn() }));

import * as scraperapi from "../src/providers/scraperapi.js";
import { hardFallback } from "../src/hardFallback.js";

beforeEach(() => {
  vi.mocked(scraperapi.scrape).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("hardFallback", () => {
  it("delegates to scraperapi and returns its result on success", async () => {
    vi.mocked(scraperapi.scrape).mockResolvedValue({ markdown: "# Bypassed", provider: "scraperapi", costActual: null });

    const result = await hardFallback("https://example.com/turnstile-protected", "layer2_failed");

    expect(result).toEqual({ markdown: "# Bypassed", provider: "scraperapi", costActual: null });
    expect(scraperapi.scrape).toHaveBeenCalledWith("https://example.com/turnstile-protected", expect.any(AbortSignal));
  });

  it("logs an audit entry with url, reason, provider, and cost on success", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.mocked(scraperapi.scrape).mockResolvedValue({ markdown: "# Ok", provider: "scraperapi", costActual: null });

    await hardFallback("https://example.com/page", "RENDER_FAILED");

    const logged = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(logged).toMatchObject({
      event: "hard_fallback_call",
      url: "https://example.com/page",
      reasonLayer2Failed: "RENDER_FAILED",
      provider: "scraperapi",
      status: "success",
    });
  });

  it("logs an audit entry and rethrows when scraperapi fails", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.mocked(scraperapi.scrape).mockRejectedValue(new Error("scraperapi request failed: 500"));

    await expect(hardFallback("https://example.com/page", "RENDER_FAILED")).rejects.toThrow("scraperapi request failed: 500");

    const logged = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(logged).toMatchObject({ event: "hard_fallback_call", status: "failed" });
  });

  it("rejects a defensively-blocklisted domain without ever calling scraperapi, and logs the bypass attempt", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(hardFallback("https://www.linkedin.com/in/someone", "layer2_failed")).rejects.toThrow("BLOCKED_LEGAL_RISK");

    expect(scraperapi.scrape).not.toHaveBeenCalled();
    const logged = JSON.parse(errorSpy.mock.calls[0]?.[0] as string);
    expect(logged).toMatchObject({ event: "hard_fallback_blocklist_bypass_suspected", url: "https://www.linkedin.com/in/someone" });
  });

  it("rejects *.bank wildcard-TLD domains defensively too", async () => {
    await expect(hardFallback("https://mycreditunion.bank/accounts", "layer2_failed")).rejects.toThrow("BLOCKED_LEGAL_RISK");
    expect(scraperapi.scrape).not.toHaveBeenCalled();
  });

  it("allows a non-blocklisted domain through", async () => {
    vi.mocked(scraperapi.scrape).mockResolvedValue({ markdown: "# Fine", provider: "scraperapi", costActual: null });
    await expect(hardFallback("https://some-docs-site.example/page", "layer2_failed")).resolves.toMatchObject({ markdown: "# Fine" });
  });

  it("aborts the scraperapi call once the 20s timeout is exceeded", async () => {
    vi.useFakeTimers();
    vi.mocked(scraperapi.scrape).mockImplementation(
      (_url, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );

    const promise = hardFallback("https://example.com/slow", "layer2_failed");
    const assertion = expect(promise).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
  });
});
