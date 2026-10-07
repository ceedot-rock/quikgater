import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    // Storage-heavy rate-limit tests should not compete across workerd instances.
    poolOptions: {
      workers: {
        singleWorker: true,
        wrangler: { configPath: "./wrangler.toml" },
        // Test-only fixtures. A clean checkout must not need .dev.vars or
        // production secrets; all Stripe/facilitator calls are mocked.
        miniflare: {
          bindings: {
            STRIPE_SECRET_KEY: "sk_test_quikgater_fixture",
            STRIPE_WEBHOOK_SECRET: "whsec_fake_for_local_dev_only",
          },
        },
      },
    },
  },
});
