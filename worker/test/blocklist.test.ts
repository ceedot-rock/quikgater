import { describe, expect, it } from "vitest";
import { isBlocklisted } from "../src/blocklist";

describe("isBlocklisted", () => {
  it("matches an exact hard-blocklist domain", () => {
    expect(isBlocklisted("wsj.com").blocked).toBe(true);
  });

  it("matches subdomains of a blocklisted domain", () => {
    const result = isBlocklisted("www.linkedin.com");
    expect(result.blocked).toBe(true);
    expect(result.matchedPattern).toBe("linkedin.com");
  });

  it("matches *.bank wildcard TLD entries", () => {
    expect(isBlocklisted("mycreditunion.bank").blocked).toBe(true);
    expect(isBlocklisted("mybank.banking").blocked).toBe(true);
  });

  it("normalizes irs.gov (spec's 'irs.gov login flows' entry)", () => {
    expect(isBlocklisted("irs.gov").blocked).toBe(true);
    expect(isBlocklisted("www.irs.gov").blocked).toBe(true);
  });

  it("does not match unrelated domains", () => {
    expect(isBlocklisted("stripe.com").blocked).toBe(false);
    expect(isBlocklisted("docs.example.com").blocked).toBe(false);
  });

  it("does not false-positive on a domain that merely contains a blocked one", () => {
    // "notwsj.com" must not match "wsj.com"
    expect(isBlocklisted("notwsj.com").blocked).toBe(false);
  });

  it("matches dynamic KV-provided patterns in addition to the hard list", () => {
    expect(isBlocklisted("paywalled-news.example", ["paywalled-news.example"]).blocked).toBe(true);
    expect(isBlocklisted("paywalled-news.example").blocked).toBe(false);
  });
});
