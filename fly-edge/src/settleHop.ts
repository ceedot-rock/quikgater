/**
 * SettleHop charge scaffold for Rider clerk → Chamber admit.
 *
 * Field set locked to Agent-Rider `agent-rider-c/cuni.c` `cuni_parse_settle_hop`
 * on main: allow hop_id, job_id, key_id, amount_usd, meter; require hop_id,
 * job_id, key_id; unknown keys → reject.extra (fail-closed).
 *
 * Default mode is mock/dry-run: reuses x402 shapes from payment.ts but NEVER
 * calls the facilitator /verify or /settle. No live debit until Corey okays.
 * PCC ≠ payment — this endpoint is hop settle admission, not a PCC config.
 */

import {
  buildPaymentRequirements,
  CACHE_HIT_PRICE_ATOMIC,
  mockSettleHopReceipt,
  NETWORK,
  type PaymentRequirements,
} from "./payment.js";

export type Env = { SETTLE_HOP_MODE?: string; PAY_TO_ADDRESS?: string };

/** Allowed exact-text keys — mirror cuni.c allow[] for SettleHop. */
export const SETTLE_HOP_ALLOWED_KEYS = [
  "hop_id",
  "job_id",
  "key_id",
  "amount_usd",
  "meter",
] as const;

export type SettleHopCode =
  | "ok"
  | "reject.empty"
  | "reject.kind"
  | "reject.extra"
  | "reject.missing"
  | "reject.funds"
  | "reject.live_disabled";

export interface SettleHop {
  hop_id: string;
  job_id: string;
  key_id: string;
  amount_usd: number;
  meter: { egress_gb: number; compute_s: number; codec_s: number };
}

export interface SettleHopResult {
  ok: boolean;
  code: SettleHopCode;
  mode: "mock";
  hop_id?: string;
  job_id?: string;
  key_id?: string;
  /** Present on ok — quoted x402 requirements shape; settled is always false in mock. */
  x402?: {
    network: string;
    maxAmountRequired: string;
    resource: string;
    settled: false;
    mock: true;
    transaction: string;
  };
  note?: string;
}

const HEADER = "CUNI SettleHop";

/**
 * Mock/dry-run is the only supported mode in this scaffold.
 * Live is refused closed (`reject.live_disabled`) until Corey okays a debit.
 *
 * Selection: env `SETTLE_HOP_MODE` unset or `mock` → mock;
 * anything else (e.g. `live`) → refuse, do not settle.
 */
export function settleHopMode(env: Env | { SETTLE_HOP_MODE?: string }): "mock" | "refuse_live" {
  const raw = (env as { SETTLE_HOP_MODE?: string }).SETTLE_HOP_MODE;
  if (raw === undefined || raw === "" || raw === "mock" || raw === "dry-run") {
    return "mock";
  }
  return "refuse_live";
}

function parseMeter(v: string): SettleHop["meter"] {
  const parts = v.split(",").map((p) => Number(p.trim()));
  return {
    egress_gb: Number.isFinite(parts[0]) ? parts[0]! : 0,
    compute_s: Number.isFinite(parts[1]) ? parts[1]! : 0,
    codec_s: Number.isFinite(parts[2]) ? parts[2]! : 0,
  };
}

/**
 * Parse CUNI SettleHop exact-text. Extras fail-closed (reject.extra).
 * Aligns with cuni_parse_settle_hop on Agent-Rider main.
 */
export function parseSettleHopText(text: string):
  | { ok: true; hop: SettleHop }
  | { ok: false; code: SettleHopCode } {
  if (!text || !text.trim()) return { ok: false, code: "reject.empty" };

  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const first = (lines[0] ?? "").trim();
  if (first !== HEADER) return { ok: false, code: "reject.kind" };

  const allowed = new Set<string>(SETTLE_HOP_ALLOWED_KEYS);
  const fields: Record<string, string> = {};
  let saw = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) return { ok: false, code: "reject.extra" };
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (!allowed.has(k)) return { ok: false, code: "reject.extra" };
    fields[k] = v;
    saw++;
  }

  if (!saw) return { ok: false, code: "reject.empty" };

  const hop_id = fields.hop_id ?? "";
  const job_id = fields.job_id ?? "";
  const key_id = fields.key_id ?? "";
  if (!hop_id || !job_id || !key_id) return { ok: false, code: "reject.missing" };

  const amountRaw = fields.amount_usd !== undefined ? Number(fields.amount_usd) : 0;
  const amount_usd = Number.isFinite(amountRaw) ? amountRaw : 0;
  const meter = fields.meter ? parseMeter(fields.meter) : { egress_gb: 0, compute_s: 0, codec_s: 0 };

  return {
    ok: true,
    hop: { hop_id, job_id, key_id, amount_usd, meter },
  };
}

/** Thin JSON wrap of bound fields — same allow-list, extras fail-closed. */
export function parseSettleHopJson(body: unknown):
  | { ok: true; hop: SettleHop }
  | { ok: false; code: SettleHopCode } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, code: "reject.kind" };
  }
  const obj = body as Record<string, unknown>;

  if (typeof obj.text === "string") {
    return parseSettleHopText(obj.text);
  }

  const allowed = new Set<string>([...SETTLE_HOP_ALLOWED_KEYS, "text"]);
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) return { ok: false, code: "reject.extra" };
  }

  const hop_id = typeof obj.hop_id === "string" ? obj.hop_id : "";
  const job_id = typeof obj.job_id === "string" ? obj.job_id : "";
  const key_id = typeof obj.key_id === "string" ? obj.key_id : "";
  if (!hop_id || !job_id || !key_id) return { ok: false, code: "reject.missing" };

  const amount_usd =
    typeof obj.amount_usd === "number" && Number.isFinite(obj.amount_usd)
      ? obj.amount_usd
      : typeof obj.amount_usd === "string"
        ? Number(obj.amount_usd) || 0
        : 0;

  let meter: SettleHop["meter"] = { egress_gb: 0, compute_s: 0, codec_s: 0 };
  if (typeof obj.meter === "string") {
    meter = parseMeter(obj.meter);
  } else if (obj.meter && typeof obj.meter === "object" && !Array.isArray(obj.meter)) {
    const m = obj.meter as Record<string, unknown>;
    meter = {
      egress_gb: Number(m.egress_gb) || 0,
      compute_s: Number(m.compute_s) || 0,
      codec_s: Number(m.codec_s) || 0,
    };
  }

  return {
    ok: true,
    hop: { hop_id, job_id, key_id, amount_usd, meter },
  };
}

function resourceForHop(hop: SettleHop): string {
  if (hop.key_id.startsWith("x402:")) {
    const rest = hop.key_id.slice("x402:".length);
    return rest || `settlehop://${hop.hop_id}`;
  }
  return `settlehop://${hop.hop_id}`;
}

/**
 * Build payment requirements via existing x402 rails, then optionally
 * override amount from the hop's amount_usd (still the same scheme/network/asset).
 */
export function quoteSettleHopRequirements(hop: SettleHop, payTo: string): PaymentRequirements {
  const resource = resourceForHop(hop);
  const base = buildPaymentRequirements({
    resource,
    payTo,
    cacheHit: true,
  });
  if (hop.amount_usd > 0) {
    return {
      ...base,
      maxAmountRequired: String(Math.max(1, Math.round(hop.amount_usd * 1_000_000))),
      description: `SettleHop mock quote (no live debit) hop_id=${hop.hop_id}`,
    };
  }
  return {
    ...base,
    maxAmountRequired: CACHE_HIT_PRICE_ATOMIC,
    description: `SettleHop mock quote (no live debit) hop_id=${hop.hop_id}`,
  };
}

/**
 * Mock charge path — reuses payment.ts requirement shapes; does NOT call
 * verifyPayment or settlePayment. Force-fail via mockFail for Chamber reject mapping.
 */
export function mockChargeSettleHop(
  hop: SettleHop,
  env: Env,
  opts: { mockFail?: boolean } = {},
): SettleHopResult {
  if (opts.mockFail) {
    return {
      ok: false,
      code: "reject.funds",
      mode: "mock",
      hop_id: hop.hop_id,
      job_id: hop.job_id,
      key_id: hop.key_id,
      note: "Mock charge failed (dry-run). No live debit attempted. PCC ≠ payment.",
    };
  }

  const payTo = env.PAY_TO_ADDRESS || "0x000000000000000000000000000000000000dEaD";
  const requirements = quoteSettleHopRequirements(hop, payTo);
  // Reuse payment.ts settle response shape — never calls facilitator.
  const receipt = mockSettleHopReceipt(hop.hop_id);

  return {
    ok: true,
    code: "ok",
    mode: "mock",
    hop_id: hop.hop_id,
    job_id: hop.job_id,
    key_id: hop.key_id,
    x402: {
      network: requirements.network || NETWORK,
      maxAmountRequired: requirements.maxAmountRequired,
      resource: requirements.resource,
      settled: false,
      mock: true,
      transaction: receipt.transaction,
    },
    note: "Dry-run mock charge admitted. No live debit. PCC ≠ payment. Live debit requires Corey okay.",
  };
}

export function httpStatusForSettleHop(result: SettleHopResult): number {
  if (result.ok) return 200;
  switch (result.code) {
    case "reject.funds":
      return 402;
    case "reject.live_disabled":
      return 501;
    default:
      return 400;
  }
}

/**
 * Full request handler body for POST /v1/settle-hop.
 * mockFail: set when request asks for forced mock failure (tests / dry-run drills).
 */
export function handleSettleHopCharge(
  hop: SettleHop,
  env: Env,
  opts: { mockFail?: boolean } = {},
): SettleHopResult {
  const mode = settleHopMode(env);
  if (mode === "refuse_live") {
    return {
      ok: false,
      code: "reject.live_disabled",
      mode: "mock",
      hop_id: hop.hop_id,
      job_id: hop.job_id,
      key_id: hop.key_id,
      note: "Live SettleHop debit is disabled until Corey okays. Default remains mock/dry-run. PCC ≠ payment.",
    };
  }
  return mockChargeSettleHop(hop, env, opts);
}
