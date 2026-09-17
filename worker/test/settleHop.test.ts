import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import {
  handleSettleHopCharge,
  mockChargeSettleHop,
  parseSettleHopJson,
  parseSettleHopText,
  quoteSettleHopRequirements,
  settleHopMode,
  SETTLE_HOP_ALLOWED_KEYS,
} from "../src/settleHop";
import { mockSettleHopReceipt, NETWORK } from "../src/payment";

const VALID_TEXT = [
  "CUNI SettleHop",
  "hop_id=hop-1",
  "job_id=job-9",
  "key_id=x402:https://example.com/fact",
  "amount_usd=0.010000",
  "meter=0.100000,1.000000,2.000000",
  "",
].join("\n");

describe("SETTLE_HOP_ALLOWED_KEYS ↔ cuni_parse_settle_hop", () => {
  it("allows hop_id, job_id, key_id, amount_usd, meter only", () => {
    expect([...SETTLE_HOP_ALLOWED_KEYS].sort()).toEqual(
      ["amount_usd", "hop_id", "job_id", "key_id", "meter"].sort(),
    );
  });
});

describe("parseSettleHopText (extras fail-closed)", () => {
  it("parses a bound SettleHop matching Agent-Rider format", () => {
    const r = parseSettleHopText(VALID_TEXT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.hop).toEqual({
      hop_id: "hop-1",
      job_id: "job-9",
      key_id: "x402:https://example.com/fact",
      amount_usd: 0.01,
      meter: { egress_gb: 0.1, compute_s: 1, codec_s: 2 },
    });
  });

  it("requires hop_id, job_id, key_id", () => {
    const r = parseSettleHopText("CUNI SettleHop\namount_usd=1\n");
    expect(r).toEqual({ ok: false, code: "reject.missing" });
  });

  it("rejects unknown keys fail-closed", () => {
    const r = parseSettleHopText(
      "CUNI SettleHop\nhop_id=h\njob_id=j\nkey_id=k\nextra_field=nope\n",
    );
    expect(r).toEqual({ ok: false, code: "reject.extra" });
  });

  it("rejects wrong kind", () => {
    expect(parseSettleHopText("CUNI ScanChunk\nurl=x\n")).toEqual({
      ok: false,
      code: "reject.kind",
    });
  });

  it("rejects empty", () => {
    expect(parseSettleHopText("")).toEqual({ ok: false, code: "reject.empty" });
    expect(parseSettleHopText("CUNI SettleHop\n")).toEqual({
      ok: false,
      code: "reject.empty",
    });
  });
});

describe("parseSettleHopJson thin wrap", () => {
  it("accepts bound fields", () => {
    const r = parseSettleHopJson({
      hop_id: "h",
      job_id: "j",
      key_id: "credits:qg_x",
      amount_usd: 0.002,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.hop.hop_id).toBe("h");
    expect(r.hop.key_id).toBe("credits:qg_x");
  });

  it("accepts { text: exact-text }", () => {
    const r = parseSettleHopJson({ text: VALID_TEXT });
    expect(r.ok).toBe(true);
  });

  it("extras fail-closed", () => {
    expect(
      parseSettleHopJson({ hop_id: "h", job_id: "j", key_id: "k", pcc: "no" }),
    ).toEqual({ ok: false, code: "reject.extra" });
  });
});

describe("mock charge (no live debit)", () => {
  it("defaults to mock mode", () => {
    expect(settleHopMode({} as Env)).toBe("mock");
    expect(settleHopMode({ SETTLE_HOP_MODE: "mock" } as Env)).toBe("mock");
    expect(settleHopMode({ SETTLE_HOP_MODE: "dry-run" } as Env)).toBe("mock");
  });

  it("refuses non-mock mode closed (no live path)", () => {
    expect(settleHopMode({ SETTLE_HOP_MODE: "live" } as Env)).toBe("refuse_live");
    const hop = parseSettleHopText(VALID_TEXT);
    expect(hop.ok).toBe(true);
    if (!hop.ok) return;
    const result = handleSettleHopCharge(hop.hop, { SETTLE_HOP_MODE: "live", PAY_TO_ADDRESS: "0xabc" } as Env);
    expect(result).toMatchObject({ ok: false, code: "reject.live_disabled", mode: "mock" });
    expect(result.note).toMatch(/PCC ≠ payment/);
  });

  it("admit path: mock success returns ok for Chamber", () => {
    const hop = parseSettleHopText(VALID_TEXT);
    expect(hop.ok).toBe(true);
    if (!hop.ok) return;
    const result = mockChargeSettleHop(hop.hop, env as Env);
    expect(result.ok).toBe(true);
    expect(result.code).toBe("ok");
    expect(result.mode).toBe("mock");
    expect(result.x402?.settled).toBe(false);
    expect(result.x402?.mock).toBe(true);
    expect(result.x402?.transaction).toBe(mockSettleHopReceipt("hop-1").transaction);
    expect(result.x402?.network).toBe(NETWORK);
    expect(result.note).toMatch(/No live debit/);
    expect(result.note).toMatch(/PCC ≠ payment/);
  });

  it("fail → reject.funds mapping", () => {
    const hop = parseSettleHopText(VALID_TEXT);
    expect(hop.ok).toBe(true);
    if (!hop.ok) return;
    const result = mockChargeSettleHop(hop.hop, env as Env, { mockFail: true });
    expect(result).toMatchObject({
      ok: false,
      code: "reject.funds",
      mode: "mock",
      hop_id: "hop-1",
    });
  });

  it("quotes via existing x402 buildPaymentRequirements rails", () => {
    const hop = parseSettleHopText(VALID_TEXT);
    expect(hop.ok).toBe(true);
    if (!hop.ok) return;
    const req = quoteSettleHopRequirements(hop.hop, "0x64E31E05583F250644b76d0FFe12e129ea4DeeCe");
    expect(req.scheme).toBe("exact");
    expect(req.network).toBe(NETWORK);
    expect(req.maxAmountRequired).toBe("10000"); // 0.01 USD * 1e6
    expect(req.resource).toBe("https://example.com/fact");
    expect(req.description).toMatch(/no live debit/i);
  });
});

describe("POST /v1/settle-hop", () => {
  it("admits on mock success (exact-text)", async () => {
    const request = new Request("http://localhost/v1/settle-hop", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: VALID_TEXT,
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      code: "ok",
      mode: "mock",
      hop_id: "hop-1",
      x402: { settled: false, mock: true },
    });
    expect(String(body.note)).toMatch(/PCC ≠ payment/);
  });

  it("maps mock fail → reject.funds", async () => {
    const request = new Request("http://localhost/v1/settle-hop", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-SettleHop-Mock": "fail",
      },
      body: JSON.stringify({
        hop_id: "hop-fail",
        job_id: "job-fail",
        key_id: "x402:https://example.com",
      }),
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(402);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: false, code: "reject.funds", mode: "mock" });
  });

  it("extras fail-closed on the wire", async () => {
    const request = new Request("http://localhost/v1/settle-hop", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "CUNI SettleHop\nhop_id=h\njob_id=j\nkey_id=k\nsneaky=1\n",
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: false, code: "reject.extra", mode: "mock" });
  });
});
