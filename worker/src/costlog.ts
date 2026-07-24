// Step 5 (cost tracking half): structured request logging matching the
// exact Tinybird schema from spec §6. No TINYBIRD_TOKEN is available in
// this environment (checked .env_secrets - nothing there), so this logs
// structured JSON via console.log (visible in `wrangler tail`) instead of
// POSTing to Tinybird. Swapping this for a real HTTP call once a token
// exists is a small, isolated change - only this file needs to change,
// every call site already passes the right shape.
export interface CostLogEntry {
  url: string;
  domain: string;
  cache_hit: boolean;
  layer: "L0" | "L1" | "L2" | "L2-browserbase" | "L2-steel" | "L2-firecrawl" | "L3" | "unresolved";
  cost_actual_usd: number | null;
  charge_usd: number;
  latency_ms: number;
  status: "success" | "blocked" | "failed" | "pending";
  block_type?: string;
  provider_error?: string;
}

export function logRequestCost(entry: CostLogEntry): void {
  console.log(JSON.stringify({ event: "request_cost", ...entry }));
}
