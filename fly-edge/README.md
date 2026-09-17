# quikgater-fly-edge

Thin Fly edge for hop settle so storefront / Rider clerk do not need the Cloudflare worker deploy token.

## Serves

- `POST /v1/settle-hop` — SettleHop mock / dry-run (same semantics as worker #4)
- `GET /v1/costs` — public cost table
- `GET /health`

Does **not** port KV / R2 / Queues / full fetch rails. Those stay on the CF worker until a fuller migration.

## Mode

- Default: mock (no live debit)
- `SETTLE_HOP_MODE=live` → `reject.live_disabled` (501) until Corey okays live debit
- Header `X-SettleHop-Mock: fail` → mock `reject.funds`

PCC ≠ payment.

## Deploy

```bash
cd fly-edge
fly apps create quikgater-fly-edge   # once
fly deploy
```

Point storefront `QUIKGATER_URL` at `https://quikgater-fly-edge.fly.dev`.
