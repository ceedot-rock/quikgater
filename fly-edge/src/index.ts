/**
 * Quikgater Fly edge — SettleHop dry-run + public costs.
 * Replaces Cloudflare workers.dev for hop settle so we do not need a CF API token.
 * Default mock/dry-run only. No live debit until Corey okays. PCC ≠ payment.
 */
import http from "node:http";
import {
  handleSettleHopCharge,
  httpStatusForSettleHop,
  parseSettleHopJson,
  parseSettleHopText,
  type Env,
  type SettleHopResult,
} from "./settleHop.js";
import { buildPublicCostsBody } from "./publicCosts.js";

const PORT = Number(process.env.PORT || 8080);

function envFromProcess(): Env {
  return {
    SETTLE_HOP_MODE: process.env.SETTLE_HOP_MODE,
    PAY_TO_ADDRESS: process.env.PAY_TO_ADDRESS,
  };
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function handleSettleHop(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const mockFail = (req.headers["x-settlehop-mock"] ?? "").toString().toLowerCase() === "fail";
  const raw = await readBody(req);
  const ct = (req.headers["content-type"] ?? "").toString().toLowerCase();
  const env = envFromProcess();

  let parsed: ReturnType<typeof parseSettleHopText>;
  if (ct.includes("application/json")) {
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      const bad: SettleHopResult = {
        ok: false,
        code: "reject.kind",
        mode: "mock",
        note: "Malformed JSON body.",
      };
      json(res, httpStatusForSettleHop(bad), bad);
      return;
    }
    parsed = parseSettleHopJson(body);
  } else {
    parsed = parseSettleHopText(raw);
  }

  if (!parsed.ok) {
    const fail: SettleHopResult = {
      ok: false,
      code: parsed.code,
      mode: "mock",
      note: "SettleHop parse rejected (fail-closed). No charge attempted. PCC ≠ payment.",
    };
    json(res, httpStatusForSettleHop(fail), fail);
    return;
  }

  const result = handleSettleHopCharge(parsed.hop, env, { mockFail });
  json(res, httpStatusForSettleHop(result), result);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const method = req.method || "GET";

    if (url.pathname === "/health" && method === "GET") {
      json(res, 200, {
        ok: true,
        service: "quikgater-fly-edge",
        settleHop: "mock",
        note: "Dry-run edge. No live debit. PCC ≠ payment.",
      });
      return;
    }

    if (url.pathname === "/v1/settle-hop" && method === "POST") {
      await handleSettleHop(req, res);
      return;
    }

    if (url.pathname === "/v1/costs" && method === "GET") {
      json(res, 200, buildPublicCostsBody());
      return;
    }

    json(res, 404, {
      success: false,
      error: "NOT_FOUND",
      note: "Fly edge serves POST /v1/settle-hop, GET /v1/costs, GET /health only.",
    });
  } catch (err) {
    console.error(err);
    json(res, 500, { success: false, error: "INTERNAL", note: String(err) });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`quikgater-fly-edge listening on :${PORT}`);
});
