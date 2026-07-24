// Hard blocklist from spec §2. Never queued, never rendered - matched
// domains return BLOCKED_LEGAL_RISK before any other work happens.
//
// Note on normalization: the spec listed "irs.gov login flows" as a raw
// entry, which isn't a valid hostname pattern - "login flows" is
// descriptive, not part of the domain. Normalized to "irs.gov" here.
// Flag to a human if the intent was narrower (e.g. only IRS *login* paths,
// not all of irs.gov) - path-scoped blocking isn't implemented, only
// domain-level.
export const HARD_BLOCKLIST: string[] = [
  "linkedin.com",
  "instagram.com",
  "facebook.com",
  "tiktok.com",
  "wsj.com",
  "nytimes.com",
  "ft.com",
  "thetimes.co.uk",
  "economist.com",
  "ticketmaster.com",
  "livenation.com",
  "*.bank",
  "*.banking",
  "chase.com",
  "wellsfargo.com",
  "login.gov",
  "irs.gov",
];

export interface BlocklistResult {
  blocked: boolean;
  reason?: "BLOCKED_LEGAL_RISK";
  matchedPattern?: string;
}

function hostnameMatchesPattern(hostname: string, rawPattern: string): boolean {
  const host = hostname.toLowerCase();
  // Spec wrote path-style entries like "linkedin.com/*". We block by
  // domain regardless of path, so the trailing "/*" is stripped and
  // ignored rather than treated as a path constraint.
  const pattern = rawPattern.toLowerCase().replace(/\/\*$/, "");

  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1); // ".bank"
    return host.endsWith(suffix);
  }
  return host === pattern || host.endsWith("." + pattern);
}

/**
 * Checks a hostname against the static HARD_BLOCKLIST plus any
 * dynamically-added patterns (e.g. the KV-maintained paywalled-news list
 * from spec §2).
 */
export function isBlocklisted(hostname: string, dynamicPatterns: string[] = []): BlocklistResult {
  for (const pattern of HARD_BLOCKLIST) {
    if (hostnameMatchesPattern(hostname, pattern)) {
      return { blocked: true, reason: "BLOCKED_LEGAL_RISK", matchedPattern: pattern };
    }
  }
  for (const pattern of dynamicPatterns) {
    if (hostnameMatchesPattern(hostname, pattern)) {
      return { blocked: true, reason: "BLOCKED_LEGAL_RISK", matchedPattern: pattern };
    }
  }
  return { blocked: false };
}
