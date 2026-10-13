# Security Policy

Quikgater moves (or is built to move) real money per fetch. A bug that lets
someone skip payment, double-spend credits, or make the service fetch on
their behalf for free is a security issue, not a normal bug.

## Reporting a vulnerability

Please do not open a public issue for security problems.

- Email: corey@slidphilabs.com with the subject line `Quikgater security`
- Or use GitHub's private vulnerability reporting on this repository
  (Security tab, "Report a vulnerability")

Include the affected package/endpoint, steps or inputs to reproduce, and
what you expected versus what happened.

You can expect an acknowledgement within 3 business days. We will keep you
updated while we investigate and credit you in the changelog unless you
prefer to stay anonymous.

## In scope

- Payment bypass: a fetch that succeeds without a valid x402 payment or
  credit debit on either rail
- SettleHop: a settle request that charges the wrong amount or the wrong party
- Edge-safety bypass: blocklist, robots.txt, or rate-limit checks that can
  be evaded
- Stripe webhook forgery: a webhook that credits an account without a real
  Stripe payment
- Credit ledger double-spend or balance manipulation
- Cache poisoning that serves one requester's paid result to another

## Out of scope

- Operator deployments we do not run
- Social engineering, spam, or denial-of-service against hosted demos
- The rented render providers themselves (Browserbase, Firecrawl,
  ScraperAPI, Steel.dev) — report to them
