import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          STRIPE_SECRET_KEY: "sk_test_quikgater_fixture",
          STRIPE_WEBHOOK_SECRET: "whsec_fake_for_local_dev_only",
        },
      },
    }),
  ],
  test: {
    maxWorkers: 1,
    setupFiles: ["./test/setup.ts"],
  },
});
