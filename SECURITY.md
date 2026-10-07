# Security reporting

Please do not post vulnerabilities, payment credentials, customer data, or
working exploits in public issues. For a private report, contact
corey@slidphilabs.com with the subject `Quikgater security report`.

Include the affected component and commit, a minimal reproduction with fake
credentials, expected versus observed behavior, and the potential impact.
Do not test against other customers, charge live accounts, or run destructive
or high-volume tests without explicit authorization.

The Cloudflare fetch Worker, browser-worker backend, and Fly dry-run edge are
separate components. Identify which one is affected; a successful local test
does not establish production safety or current deployment behavior.

No response-time, bounty, certification, or production-readiness commitment is
implied by this policy. This document does not enable GitHub private
vulnerability reporting or authorize security testing of hosted services.
