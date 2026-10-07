## What changed

<!-- One or two sentences. -->

## Components touched

<!-- e.g. worker/src/payment.ts, browser-worker/src/render.ts, fly-edge/src/settleHop.ts, docs, or "none" -->

## Checks

- [ ] `browser-worker`: `npm ci && npm test && npm run typecheck` passes
- [ ] `worker`: `npm ci && npm test && npm run typecheck` passes
- [ ] `fly-edge`: `npm ci && npm run build`, boots, `/health` and `/v1/costs` answer
- [ ] Money math stays in integer atomic units (no floats on any price path)
- [ ] No secrets, keys, or credentials added to the repo
