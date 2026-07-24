import { describe, expect, it } from "vitest";
import { robotsAllows } from "../src/robots";

describe("robotsAllows", () => {
  it("allows everything when robots.txt is empty", () => {
    expect(robotsAllows("", "/anything")).toBe(true);
  });

  it("disallows a blocked path", () => {
    const txt = "User-agent: *\nDisallow: /private";
    expect(robotsAllows(txt, "/private/page")).toBe(false);
  });

  it("allows a path not covered by any disallow rule", () => {
    const txt = "User-agent: *\nDisallow: /private";
    expect(robotsAllows(txt, "/public/page")).toBe(true);
  });

  it("longest match wins, so a more specific Allow overrides a shorter Disallow", () => {
    const txt = "User-agent: *\nDisallow: /docs\nAllow: /docs/public";
    expect(robotsAllows(txt, "/docs/public/page")).toBe(true);
    expect(robotsAllows(txt, "/docs/private/page")).toBe(false);
  });

  it("ties between equal-length Allow/Disallow favor Allow", () => {
    const txt = "User-agent: *\nDisallow: /x\nAllow: /x";
    expect(robotsAllows(txt, "/x")).toBe(true);
  });

  it("falls back to the * group when there's no fetchgate-specific group", () => {
    const txt = "User-agent: Googlebot\nDisallow: /\nUser-agent: *\nDisallow: /only-this";
    expect(robotsAllows(txt, "/anything-else")).toBe(true);
    expect(robotsAllows(txt, "/only-this/page")).toBe(false);
  });

  it("prefers a fetchgate-specific group over *", () => {
    const txt = "User-agent: fetchgate\nDisallow: /no-bots-of-any-kind\nUser-agent: *\nDisallow: /";
    // The "*" group blocks everything, but a fetchgate-specific group
    // exists and only blocks one path - it should win entirely.
    expect(robotsAllows(txt, "/anything")).toBe(true);
    expect(robotsAllows(txt, "/no-bots-of-any-kind/x")).toBe(false);
  });
});
