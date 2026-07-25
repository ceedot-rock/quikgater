import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/providers/browserbase.js", () => ({ render: vi.fn() }));
vi.mock("../src/providers/steeldev.js", () => ({ render: vi.fn() }));
vi.mock("../src/providers/firecrawl.js", () => ({ scrape: vi.fn() }));

import * as browserbase from "../src/providers/browserbase.js";
import * as steeldev from "../src/providers/steeldev.js";
import * as firecrawl from "../src/providers/firecrawl.js";
import { render } from "../src/render.js";

beforeEach(() => {
  vi.mocked(browserbase.render).mockReset();
  vi.mocked(steeldev.render).mockReset();
  vi.mocked(firecrawl.scrape).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("render (Layer 2 failover orchestrator)", () => {
  it("returns browserbase's result without trying the other providers when it succeeds", async () => {
    vi.mocked(browserbase.render).mockResolvedValue({
      markdown: "# BB",
      providerUsed: "browserbase",
      costActual: null,
      title: null,
    });

    const result = await render("https://example.com");

    expect(result).toEqual({ markdown: "# BB", providerUsed: "browserbase", costActual: null, title: null });
    expect(steeldev.render).not.toHaveBeenCalled();
    expect(firecrawl.scrape).not.toHaveBeenCalled();
  });

  it("falls to steeldev when browserbase fails, then never reaches firecrawl", async () => {
    vi.mocked(browserbase.render).mockRejectedValue(new Error("bb down"));
    vi.mocked(steeldev.render).mockResolvedValue({
      markdown: "# Steel",
      providerUsed: "steeldev",
      costActual: null,
      title: null,
    });

    const result = await render("https://example.com");

    expect(result.providerUsed).toBe("steeldev");
    expect(firecrawl.scrape).not.toHaveBeenCalled();
  });

  it("falls all the way to firecrawl when browserbase and steeldev both fail", async () => {
    vi.mocked(browserbase.render).mockRejectedValue(new Error("bb down"));
    vi.mocked(steeldev.render).mockRejectedValue(new Error("steel down"));
    vi.mocked(firecrawl.scrape).mockResolvedValue({
      markdown: "# FC",
      providerUsed: "firecrawl",
      costActual: null,
      title: null,
    });

    const result = await render("https://example.com");

    expect(result.providerUsed).toBe("firecrawl");
  });

  it("throws RENDER_FAILED when every provider fails", async () => {
    vi.mocked(browserbase.render).mockRejectedValue(new Error("bb down"));
    vi.mocked(steeldev.render).mockRejectedValue(new Error("steel down"));
    vi.mocked(firecrawl.scrape).mockRejectedValue(new Error("fc down"));

    await expect(render("https://example.com")).rejects.toThrow("RENDER_FAILED");
  });

  it("passes an AbortSignal through to each provider", async () => {
    vi.mocked(browserbase.render).mockImplementation(async (_url, signal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);
      throw new Error("bb down");
    });
    vi.mocked(steeldev.render).mockResolvedValue({
      markdown: "# Steel",
      providerUsed: "steeldev",
      costActual: null,
      title: null,
    });

    await render("https://example.com");

    expect(browserbase.render).toHaveBeenCalledWith("https://example.com", expect.any(AbortSignal));
  });

  it("stops trying further providers once the 15s total budget is exhausted", async () => {
    vi.useFakeTimers();

    // browserbase "hangs" until the timeout fires and aborts it.
    vi.mocked(browserbase.render).mockImplementation(
      (_url, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );

    const renderPromise = render("https://example.com");
    // Attach the rejection handler before advancing timers, so the
    // rejection that fires when the abort event lands is never briefly
    // unhandled (which vitest correctly flags as a real issue, not noise).
    const assertion = expect(renderPromise).rejects.toThrow("RENDER_FAILED");

    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;

    expect(steeldev.render).not.toHaveBeenCalled();
    expect(firecrawl.scrape).not.toHaveBeenCalled();
  });
});
