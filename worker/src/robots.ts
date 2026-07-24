import type { Env } from "./env";

// Identify ourselves distinctly in both the fetch UA and the robots.txt
// group we prefer, so a site can carve out rules specifically for
// Quikgater instead of only ever hitting their "*" group.
export const USER_AGENT = "quikgater";
const ROBOTS_CACHE_TTL_SECONDS = 60 * 60 * 24; // 24h, per spec §2

interface Rule {
  type: "allow" | "disallow";
  path: string;
}

/**
 * Simplified RFC 9309 parser: supports User-agent / Allow / Disallow
 * groups, longest-match-wins with ties going to Allow. Does NOT support
 * wildcard (*) or end-anchor ($) path patterns within a rule - if a
 * target domain relies on those, this will under- or over-block and
 * needs extending before that domain is trusted.
 */
function parseGroups(robotsTxt: string): Map<string, Rule[]> {
  const groups = new Map<string, Rule[]>();
  let currentAgents: string[] = [];
  let groupOpenForMoreAgents = true;

  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = rawLine.split("#")[0]!.trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (key === "user-agent") {
      const agent = value.toLowerCase();
      if (!groupOpenForMoreAgents) {
        currentAgents = [];
        groupOpenForMoreAgents = true;
      }
      currentAgents.push(agent);
      if (!groups.has(agent)) groups.set(agent, []);
    } else if (key === "allow" || key === "disallow") {
      for (const agent of currentAgents) {
        groups.get(agent)!.push({ type: key, path: value });
      }
      groupOpenForMoreAgents = false;
    }
  }
  return groups;
}

export function robotsAllows(robotsTxt: string, path: string): boolean {
  if (!robotsTxt.trim()) return true; // no robots.txt (or fetch failed) => allow

  const groups = parseGroups(robotsTxt);
  const rules = groups.get(USER_AGENT) ?? groups.get("*") ?? [];

  let best: Rule | null = null;
  for (const rule of rules) {
    if (rule.path === "") continue; // empty Disallow/Allow value is a no-op
    if (!path.startsWith(rule.path)) continue;
    if (!best || rule.path.length > best.path.length) {
      best = rule;
    } else if (rule.path.length === best.path.length && rule.type === "allow") {
      best = rule; // tie -> Allow wins
    }
  }
  return !best || best.type === "allow";
}

/**
 * Fetches robots.txt for an origin, caching the raw body in KV for 24h.
 *
 * Judgment call: on fetch failure (network error, timeout) this fails
 * OPEN (treats it as no robots.txt => allow), to avoid an unrelated
 * transient error blocking legitimate traffic given reliability is the
 * product's whole pitch. That trades against "default: respect
 * robots.txt" from spec §2 - worth a second opinion before shipping if a
 * stricter fail-closed posture is actually wanted.
 */
export async function getRobotsTxt(
  origin: string,
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const cacheKey = `robots:${origin}`;
  const cached = await env.ROBOTS_KV.get(cacheKey);
  if (cached !== null) return cached;

  let body = "";
  try {
    const res = await fetchImpl(`${origin}/robots.txt`, {
      headers: { "user-agent": `${USER_AGENT}-bot (+https://quikgater.com/bot)` },
    });
    if (res.ok) body = await res.text();
    // non-2xx (404, etc.) => treat as "no robots.txt" (empty => allow-all)
  } catch {
    body = "";
  }

  await env.ROBOTS_KV.put(cacheKey, body, { expirationTtl: ROBOTS_CACHE_TTL_SECONDS });
  return body;
}
