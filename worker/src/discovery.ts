import { NETWORK } from "./payment";

/** Static discovery only: no storage, outbound requests, or billing. */
export function buildDiscoveryBody() {
  return {
    success: true,
    service: "quikgater-worker",
    description: "Pay-per-fetch web content for agents.",
    docs: "https://github.com/ceedot-rock/quikgater/blob/master/docs/QUICKSTART.md",
    routes: {
      discovery: "GET /",
      health: "GET /health",
      costs: "GET /v1/costs",
      fetch: "GET /?url=<encoded-http-or-https-url>",
      job: "GET /v1/job/{jobId}",
      balance: "GET /v1/credits/balance",
      depositCheckout: "POST /v1/credits/checkout",
      proCheckout: "POST /v1/pro/checkout",
      proStatus: "GET /v1/pro/status",
      settleHop: "POST /v1/settle-hop",
    },
    payment: {
      x402: { network: NETWORK, header: "X-PAYMENT", quotes: "/v1/costs" },
      credits: {
        header: "Authorization: Bearer <quikgater-api-key>",
        note: "Credits take precedence over X-PAYMENT and can represent real money.",
      },
      free: "Eligible unauthenticated cache hits only; not free uncached fetches.",
      settleHop: "Dry-run only. Live mode is rejected; no live hop debit.",
    },
    responses: {
      200: "Content delivered, or an informational response.",
      202: "Render queued. Poll pollUrl; do not repeat the paid fetch.",
      402: "Payment authorization or sufficient credits required.",
      429: "Rate limited.",
    },
    limitations: [
      "Health reports process liveness, not provider or payment readiness.",
      "A Rider identity is not a Quikgater payment credential.",
      "The Fly edge is a separate dry-run hop service, not the full fetch API.",
    ],
  };
}
