import type { RenderJob } from "./queue";

export interface Env {
  BLOCKLIST_KV: KVNamespace;
  ROBOTS_KV: KVNamespace;
  RATELIMIT_KV: KVNamespace;
  // Step 5: Layer 0 dedup cache - metadata in KV, body in R2.
  CACHE_KV: KVNamespace;
  CACHE_R2: R2Bucket;
  // Base Sepolia wallet address that receives x402 USDC payments. Public
  // address, not a secret - but there is no default; the worker refuses
  // to boot the payment gate without it (see index.ts).
  PAY_TO_ADDRESS: string;
  // Step 4: async render queue + job status storage.
  RENDER_QUEUE: Queue<RenderJob>;
  JOBS_KV: KVNamespace;
  // quikgater-browser-worker's base URL (Fly.io). Public, not a secret.
  BROWSER_WORKER_URL: string;
}
