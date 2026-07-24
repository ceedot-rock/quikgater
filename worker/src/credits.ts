import type { Env } from "./env";

// Rail B (spec §5): Deposit Credits. An account is just an API key ->
// balance mapping in KV - no separate signup step, no email/password.
// The key IS the account. Balance is stored in the same atomic unit as
// Rail A's x402 prices (1 unit = $0.000001, matching USDC's 6 decimals -
// see payment.ts's CACHE_HIT_PRICE_ATOMIC/MISS_PRICE_ATOMIC), so the same
// price constants can be reused directly for debits without a conversion.
//
// KV is eventually-consistent, same caveat as RATELIMIT_KV in
// wrangler.toml: a debit is a read-modify-write, not a real atomic
// decrement. Two concurrent requests against the same account could both
// read the same balance and both succeed when only one should have. A
// Durable Object would fix this properly; not built here, same tradeoff
// already accepted elsewhere in this codebase for a KV-backed counter.

const API_KEY_PREFIX = "qg_";

export interface Account {
  apiKey: string;
  balanceAtomic: number;
  createdAt: number;
}

function accountKey(apiKey: string): string {
  return `account:${apiKey}`;
}

export function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const token = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${API_KEY_PREFIX}${token}`;
}

export async function getAccount(env: Env, apiKey: string): Promise<Account | null> {
  const raw = await env.CREDITS_KV.get(accountKey(apiKey));
  return raw ? (JSON.parse(raw) as Account) : null;
}

/** Creates a new zero-balance account. Used up front when a deposit checkout is started, so the Stripe webhook has an account to credit once payment completes. */
export async function createAccount(env: Env, apiKey: string): Promise<Account> {
  const account: Account = { apiKey, balanceAtomic: 0, createdAt: Date.now() };
  await env.CREDITS_KV.put(accountKey(apiKey), JSON.stringify(account));
  return account;
}

/** Adds credits to an existing account (called by the Stripe webhook after a real completed checkout). Creates the account if it somehow doesn't exist yet, rather than silently dropping a real payment. */
export async function creditAccount(env: Env, apiKey: string, amountAtomic: number): Promise<Account> {
  const existing = await getAccount(env, apiKey);
  const account: Account = existing
    ? { ...existing, balanceAtomic: existing.balanceAtomic + amountAtomic }
    : { apiKey, balanceAtomic: amountAtomic, createdAt: Date.now() };
  await env.CREDITS_KV.put(accountKey(apiKey), JSON.stringify(account));
  return account;
}

export type DebitResult = { success: true; newBalanceAtomic: number } | { success: false; reason: "INVALID_API_KEY" | "INSUFFICIENT_CREDITS" };

/** Debits an account for a request. Read-modify-write, not atomic - see the module comment above. */
export async function debitAccount(env: Env, apiKey: string, amountAtomic: number): Promise<DebitResult> {
  const account = await getAccount(env, apiKey);
  if (!account) return { success: false, reason: "INVALID_API_KEY" };
  if (account.balanceAtomic < amountAtomic) return { success: false, reason: "INSUFFICIENT_CREDITS" };

  const newBalanceAtomic = account.balanceAtomic - amountAtomic;
  await env.CREDITS_KV.put(accountKey(apiKey), JSON.stringify({ ...account, balanceAtomic: newBalanceAtomic }));
  return { success: true, newBalanceAtomic };
}
