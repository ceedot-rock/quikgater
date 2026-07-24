import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { render } from "./render.js";
import { hardFallback } from "./hardFallback.js";

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

// Step 3 (Split Routes): single undifferentiated /fetch-stealth endpoint
// from v1 is gone. Two explicit routes per spec §4/§8 Step 3:
const server = createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/render") {
      const body = (await readJsonBody(req)) as { url?: string };
      if (!body.url) return sendJson(res, 400, { success: false, error: "MISSING_URL" });
      try {
        const result = await render(body.url);
        return sendJson(res, 200, { success: true, ...result });
      } catch {
        // Layer 2 exhausted all providers - caller (Worker queue consumer)
        // is expected to fall through to /hard-fallback per spec §3 diagram.
        return sendJson(res, 502, { success: false, error: "RENDER_FAILED" });
      }
    }

    if (req.method === "POST" && req.url === "/hard-fallback") {
      const body = (await readJsonBody(req)) as { url?: string; reason?: string };
      if (!body.url) return sendJson(res, 400, { success: false, error: "MISSING_URL" });
      try {
        const result = await hardFallback(body.url, body.reason ?? "unspecified");
        return sendJson(res, 200, { success: true, ...result });
      } catch {
        return sendJson(res, 502, { success: false, error: "HARD_FALLBACK_FAILED" });
      }
    }

    if (req.method === "GET" && req.url === "/health") {
      return sendJson(res, 200, { ok: true });
    }

    sendJson(res, 404, { success: false, error: "NOT_FOUND" });
  } catch (e) {
    console.error("unhandled error", e);
    sendJson(res, 500, { success: false, error: "INTERNAL_ERROR" });
  }
});

server.listen(PORT, () => {
  console.log(`fetchgate-browser-worker listening on :${PORT}`);
});
