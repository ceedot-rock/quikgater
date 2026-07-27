import type { IncomingMessage, ServerResponse } from "node:http";
import { render } from "../src/render.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    return sendJson(res, 405, { success: false, error: "METHOD_NOT_ALLOWED" });
  }

  try {
    const body = (await readJsonBody(req)) as { url?: string };
    if (!body.url) return sendJson(res, 400, { success: false, error: "MISSING_URL" });

    const result = await render(body.url);
    return sendJson(res, 200, { success: true, ...result });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return sendJson(res, 400, { success: false, error: "INVALID_JSON" });
    }

    return sendJson(res, 502, { success: false, error: "RENDER_FAILED" });
  }
}
