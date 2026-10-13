import { env } from "cloudflare:test";
import { beforeEach } from "vitest";

// Vitest 4's Workers pool isolates storage per FILE, not per test.
// Keep the existing suite's clean-store contract explicitly.
beforeEach(async () => {
  for (const kv of [
    env.BLOCKLIST_KV, env.ROBOTS_KV, env.RATELIMIT_KV,
    env.CACHE_KV, env.JOBS_KV, env.CREDITS_KV,
  ]) {
    // Delete a full page and relist from the beginning. No stale cursor
    // assumptions after deleting keys from the list being traversed.
    for (;;) {
      const page = await kv.list();
      if (page.keys.length === 0) break;
      await Promise.all(page.keys.map(({ name }) => kv.delete(name)));
    }
  }
  for (;;) {
    const page = await env.CACHE_R2.list();
    if (page.objects.length === 0) break;
    await env.CACHE_R2.delete(page.objects.map(({ key }) => key));
  }
});
