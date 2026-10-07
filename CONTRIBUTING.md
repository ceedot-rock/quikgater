# Contributing to Quikgater

Thanks for helping build pay-per-fact web fetch for AI agents.

## Layout

- `worker/` — `quikgater-worker`, the Cloudflare Worker edge layer
  (blocklist, robots.txt, rate limiting, x402/credits billing, SettleHop).
- `browser-worker/` — `quikgater-browser-worker`, the Fly.io render service
  (Layer 2 rented render failover, Layer 3 hard fallback).
- `fly-edge/` — `quikgater-fly-edge`, the Fly.io SettleHop dry-run + costs API
  (replaces the Cloudflare edge for settle-hop so no CF API token is needed).

## Ground rules

- All money math is in integer atomic units (1,000,000 atomic = 1 USD).
  No floats on any price path, ever.
- Mock/dry-run stays the default for anything that could move money.
  No live debit, no live settlement, without an explicit go from the maintainer.
- A refusal from the edge-safety checks (blocklist, robots.txt, rate limit)
  is a result, not something to work around.

## Quick checks

```sh
cd browser-worker && npm ci && npm test && npm run typecheck
cd ../worker && npm ci && npm test && npm run typecheck
cd ../fly-edge && npm ci && npm run build
```

CI runs all of the above plus a boot-and-curl smoke test of fly-edge
(`/health`, `/v1/costs`, `/v1/settle-hop`) on every pull request.

## Service discovery

The worker exposes `GET /service/about/endpoints` — a machine-readable list
of the API's endpoints. If you add a route to `worker/src/index.ts`, add it
to `buildServiceAboutBody()` in the same file and keep the version read from
`worker/package.json` (never hardcode it).

## Adding or changing an endpoint

1. Make the change in the right package (`worker`, `browser-worker`, or `fly-edge`).
2. Add or update tests (vitest) covering the new behavior.
3. Run the quick checks for that package.
4. Open a pull request using the template.

## Licensing

Quikgater is MIT licensed (see LICENSE). By contributing you agree your
contribution may be distributed under that license.
