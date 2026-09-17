# Rider SettleHop on quikgater

Do not add a second payment protocol.

- Worker already verifies and settles via `worker/src/payment.ts` and the x402 facilitator.
- Rider clerk sends `key_id=x402:<resource>` plus `X-PAYMENT`.
- Agent-Rider `POST /api/settle` can forward that rail without calling quikgater, using the same facilitator env.
- If the hop is a fetch-fact, keep charging on the existing worker route; map `job_id` to the resource URL.

Human rails (Stripe, tiun) stay attach-only.
