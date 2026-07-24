import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createAccount, creditAccount, debitAccount, generateApiKey, getAccount } from "../src/credits";
import type { Env } from "../src/env";

describe("generateApiKey", () => {
  it("generates keys with the qg_ prefix", () => {
    expect(generateApiKey()).toMatch(/^qg_[0-9a-f]{48}$/);
  });

  it("generates a different key each call", () => {
    expect(generateApiKey()).not.toBe(generateApiKey());
  });
});

describe("getAccount / createAccount", () => {
  it("returns null for an unknown api key", async () => {
    expect(await getAccount(env as Env, "qg_does_not_exist")).toBeNull();
  });

  it("creates a zero-balance account", async () => {
    const account = await createAccount(env as Env, "qg_new_account");
    expect(account).toMatchObject({ apiKey: "qg_new_account", balanceAtomic: 0 });
    expect(await getAccount(env as Env, "qg_new_account")).toEqual(account);
  });
});

describe("creditAccount", () => {
  it("adds to an existing account's balance", async () => {
    await createAccount(env as Env, "qg_credit_existing");
    const account = await creditAccount(env as Env, "qg_credit_existing", 5_000_000);
    expect(account.balanceAtomic).toBe(5_000_000);
    const second = await creditAccount(env as Env, "qg_credit_existing", 1_000_000);
    expect(second.balanceAtomic).toBe(6_000_000);
  });

  it("creates the account if a webhook fires for one that doesn't exist yet, rather than dropping a real payment", async () => {
    const account = await creditAccount(env as Env, "qg_credit_new", 20_000_000);
    expect(account.balanceAtomic).toBe(20_000_000);
    expect(await getAccount(env as Env, "qg_credit_new")).not.toBeNull();
  });
});

describe("debitAccount", () => {
  it("returns INVALID_API_KEY for an unknown account", async () => {
    const result = await debitAccount(env as Env, "qg_unknown", 100);
    expect(result).toEqual({ success: false, reason: "INVALID_API_KEY" });
  });

  it("returns INSUFFICIENT_CREDITS and does not modify the balance when the debit exceeds it", async () => {
    await creditAccount(env as Env, "qg_low_balance", 100);
    const result = await debitAccount(env as Env, "qg_low_balance", 200);
    expect(result).toEqual({ success: false, reason: "INSUFFICIENT_CREDITS" });
    const account = await getAccount(env as Env, "qg_low_balance");
    expect(account?.balanceAtomic).toBe(100);
  });

  it("subtracts the debited amount on success", async () => {
    await creditAccount(env as Env, "qg_debit_ok", 1_000_000);
    const result = await debitAccount(env as Env, "qg_debit_ok", 80_000);
    expect(result).toEqual({ success: true, newBalanceAtomic: 920_000 });
    const account = await getAccount(env as Env, "qg_debit_ok");
    expect(account?.balanceAtomic).toBe(920_000);
  });

  it("allows debiting the exact remaining balance to zero", async () => {
    await creditAccount(env as Env, "qg_debit_exact", 500);
    const result = await debitAccount(env as Env, "qg_debit_exact", 500);
    expect(result).toEqual({ success: true, newBalanceAtomic: 0 });
  });
});
