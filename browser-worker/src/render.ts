import * as browserbase from "./providers/browserbase.js";
import * as steeldev from "./providers/steeldev.js";
import * as firecrawl from "./providers/firecrawl.js";

// Step 3 (Split Routes) + Step 6 (Multi-Provider Failover): failover
// orchestrator from spec §4 Layer 2's pseudocode. Browserbase primary,
// Steel.dev then Firecrawl as fallbacks, in that order per spec.
export interface RenderResponse {
  markdown: string;
  providerUsed: string;
  costActual: number | null;
  title: string | null;
}

const TOTAL_TIMEOUT_MS = 15_000; // spec §4 Layer 2: "Timeout: 15s total"

type Attempt = (signal: AbortSignal) => Promise<RenderResponse>;

export async function render(url: string): Promise<RenderResponse> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Layer 2 15s total timeout exceeded")),
    TOTAL_TIMEOUT_MS,
  );

  const attempts: Attempt[] = [
    (signal) => browserbase.render(url, signal),
    (signal) => steeldev.render(url, signal),
    (signal) => firecrawl.scrape(url, signal),
  ];

  try {
    for (const attempt of attempts) {
      if (controller.signal.aborted) break; // budget's gone, don't start another provider
      try {
        return await attempt(controller.signal);
      } catch (e) {
        console.error("render provider failed", e);
      }
    }
  } finally {
    clearTimeout(timer);
  }

  throw new Error("RENDER_FAILED");
}
