import { describe, expect, it } from "vitest";
import { tryLayer1Fetch } from "../src/layer1";

function fakeFetch(response: Partial<Response> & { text?: () => Promise<string> }): typeof fetch {
  return (async () => response as Response) as typeof fetch;
}

const LONG_PARAGRAPH = "This is real, server-rendered body text. ".repeat(10);

describe("tryLayer1Fetch", () => {
  it("returns markdown + title for a normal server-rendered HTML page", async () => {
    const html = `<html><head><title>Real Page</title></head><body><h1>Hi</h1><p>${LONG_PARAGRAPH}</p></body></html>`;
    const fetchImpl = fakeFetch({
      ok: true,
      headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
      text: async () => html,
    });

    const result = await tryLayer1Fetch("https://example.com/page", fetchImpl);

    expect(result).not.toBeNull();
    expect(result?.title).toBe("Real Page");
    expect(result?.markdown).toContain("Real Page");
    expect(result?.markdown).toContain("real, server-rendered body text");
  });

  it("strips script and style tags out of the extracted text", async () => {
    const html = `<html><head><title>T</title><style>.x{color:red}</style></head><body><script>evil()</script><p>${LONG_PARAGRAPH}</p></body></html>`;
    const fetchImpl = fakeFetch({
      ok: true,
      headers: new Headers({ "content-type": "text/html" }),
      text: async () => html,
    });

    const result = await tryLayer1Fetch("https://example.com/page", fetchImpl);

    expect(result?.markdown).not.toContain("evil()");
    expect(result?.markdown).not.toContain("color:red");
  });

  it("returns null on a non-2xx response", async () => {
    const fetchImpl = fakeFetch({ ok: false });
    const result = await tryLayer1Fetch("https://example.com/missing", fetchImpl);
    expect(result).toBeNull();
  });

  it("returns null for a non-HTML/text content-type (e.g. a JSON API)", async () => {
    const fetchImpl = fakeFetch({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => `{"ok":true}`,
    });
    const result = await tryLayer1Fetch("https://example.com/api", fetchImpl);
    expect(result).toBeNull();
  });

  it("returns null when the page body is too short (likely a JS-shell SPA)", async () => {
    const html = `<html><head><title>App</title></head><body><div id="root"></div></body></html>`;
    const fetchImpl = fakeFetch({
      ok: true,
      headers: new Headers({ "content-type": "text/html" }),
      text: async () => html,
    });
    const result = await tryLayer1Fetch("https://example.com/spa", fetchImpl);
    expect(result).toBeNull();
  });

  it("returns null when the page looks like an active bot challenge", async () => {
    const html = `<html><head><title>Just a moment...</title></head><body><p>${LONG_PARAGRAPH} Checking your browser before accessing.</p></body></html>`;
    const fetchImpl = fakeFetch({
      ok: true,
      headers: new Headers({ "content-type": "text/html" }),
      text: async () => html,
    });
    const result = await tryLayer1Fetch("https://example.com/challenged", fetchImpl);
    expect(result).toBeNull();
  });

  it("returns null when the fetch itself throws (network error, timeout, DNS failure)", async () => {
    const fetchImpl = (async () => {
      throw new Error("network error");
    }) as typeof fetch;
    const result = await tryLayer1Fetch("https://does-not-resolve.invalid/", fetchImpl);
    expect(result).toBeNull();
  });

  it("falls back to the URL as the title when no <title> tag is present", async () => {
    const html = `<html><body><p>${LONG_PARAGRAPH}</p></body></html>`;
    const fetchImpl = fakeFetch({
      ok: true,
      headers: new Headers({ "content-type": "text/html" }),
      text: async () => html,
    });
    const result = await tryLayer1Fetch("https://example.com/no-title", fetchImpl);
    expect(result?.title).toBe("https://example.com/no-title");
  });
});
