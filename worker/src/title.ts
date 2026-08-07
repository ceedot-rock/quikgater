/**
 * Title extraction scaffold (Step 2 — open tasks).
 * Prefer real HTML title / og:title; fall back to URL slug.
 * No network I/O here — pure string helpers for Worker + tests.
 */

export function titleFromHtml(html: string): string | null {
  if (!html || typeof html !== "string") return null;
  const og = html.match(
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i
  ) || html.match(
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i
  );
  if (og?.[1]) return decodeEntities(og[1].trim());

  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (t?.[1]) {
    const cleaned = decodeEntities(t[1].replace(/\s+/g, " ").trim());
    if (cleaned) return cleaned.slice(0, 300);
  }
  return null;
}

export function titleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, "");
    const last = path.split("/").filter(Boolean).pop() || u.hostname;
    return decodeURIComponent(last.replace(/[-_]+/g, " ")).slice(0, 200);
  } catch {
    return "untitled";
  }
}

export function resolveTitle(opts: {
  html?: string | null;
  url: string;
  existing?: string | null;
}): string {
  if (opts.existing && opts.existing.trim()) return opts.existing.trim().slice(0, 300);
  const fromHtml = opts.html ? titleFromHtml(opts.html) : null;
  if (fromHtml) return fromHtml;
  return titleFromUrl(opts.url);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}
