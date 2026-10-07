# Quikgater developer quickstart

Quikgater returns web content through a cache, direct fetch, and asynchronous
render pipeline. This guide describes the repository implementation, not a
verification of what is currently deployed.

## Choose the right service

- **Cloudflare Worker (`worker/`):** full fetch API, cache, jobs, x402 and credits.
- **Browser worker (`browser-worker/`):** render-provider backend, not the client entry point.
- **Fly edge (`fly-edge/`):** costs and dry-run SettleHop only, not a fetch API.

The repository's historical Cloudflare address is
https://quikgater-worker.ceedotrock.workers.dev. Set `QG_BASE` to the instance you
intend to use; the examples below default to a local Worker.

## Inspect without paying

```bash
QG_BASE=http://localhost:8788
curl -fsS "$QG_BASE/"
curl -fsS "$QG_BASE/health"
curl -fsS "$QG_BASE/v1/costs"
```

These informational routes do not fetch target pages or debit accounts.
Health is liveness only, not a check of Stripe, storage, render providers, or
the facilitator. The root and health endpoints are new in this revision.

## Request content

```bash
# No payment credential. Expect 402 on a miss, or an eligible free cache hit.
curl -sS --get "$QG_BASE/" --data-urlencode 'url=https://example.com'
```

- **200:** content is returned in `markdown`, with cache/tier/payment metadata.
- **202:** rendering is queued. Save `jobId` and poll the relative `pollUrl`.
- **402:** payment is required or the credits balance is insufficient.
- **403 / 429:** a policy or rate-limit rejection. Do not retry in a tight loop.

```bash
# Poll the returned job ID, not the original paid fetch.
curl -sS "$QG_BASE/v1/job/<job-id>"
```

A polling response can be HTTP 200 while the job is still `pending` or has
`failed`; inspect `status`, `error`, and payment/settlement fields. A completed
render does not by itself establish successful settlement. Treat job IDs as
private capabilities: the current endpoint does not authenticate the caller.

## Payment is separate from identity

- **x402:** use the actual 402 `accepts` requirements to obtain a valid
  authorization, then retry with `X-PAYMENT`. The repository uses Base Sepolia.
  Cache hits and misses are quoted before signing; inspect `/v1/costs`.
- **Credits:** an existing Quikgater key goes in `Authorization: Bearer ...`.
  This takes precedence over `X-PAYMENT` and bills the actual result tier.
  Hosted credits may represent real money. This guide does not create or fund
  an account or complete a checkout.
- **Rider:** `ar_` keys and `X-Agent-Rider` credentials are not Quikgater credits
  or payment authorization. Quikgater's SettleHop scaffold does not make a
  Rider identity spend-capable; live hop mode is rejected.

Keep credentials in a vault or environment injection, never in URLs, example
files, logs, or source control. Review the destination and quote before sending
payment credentials. No example here signs a payment or authorizes a purchase.

## Run the local checks

Requires Node 20 and npm. From a clean checkout:

```bash
(cd worker && npm ci && npm run typecheck && npm test)
(cd browser-worker && npm ci && npm run typecheck && npm test)
(cd fly-edge && npm ci && npm run build)
```

The Worker test configuration supplies fake Stripe bindings; tests do not need
an untracked `.dev.vars` file or real Stripe secrets. Provider calls are mocked.
To run the local fetch Worker, use `cd worker && npm run dev -- --local --port 8788`.
Unlike the automated tests, the development server can make outbound calls:
do not add production payment/provider credentials just to try the API index.

## Release boundaries

Passing these checks is not a production security audit. The credits ledger is
KV-backed and non-atomic under concurrent writes; webhook replay/idempotency,
target/redirect restrictions, dependency advisories, and production secret and
provider configuration need dedicated review before scaling paid traffic.

This change does not change pricing, switch networks, deploy services, fund
wallets, charge cards, or enable live SettleHop. Existing historical build-log
claims should not be used as evidence of current deployment health.
