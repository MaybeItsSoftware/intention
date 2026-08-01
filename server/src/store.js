// Small pieces of server state: the coaching-credit balance ledger, the
// idempotency record that stops a top-up being credited twice, and the
// one-time codes that link a browser to credit bought in a mobile app.
//
// All in-memory by design — a single process is enough to run this, and none
// of it is worth a database on its own. Swap MemoryStore for a Redis/KV
// implementation of the same four methods when running more than one instance;
// nothing else has to change (the balance and idempotency keys move with it
// for free — they're just get/set).

export class MemoryStore {
  constructor() {
    this.map = new Map();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt < Date.now()) {
      this.map.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key, value, ttlMs) {
    this.map.set(key, { value, expiresAt: ttlMs ? Date.now() + ttlMs : 0 });
  }

  delete(key) {
    this.map.delete(key);
  }

  increment(key, ttlMs) {
    const current = Number(this.get(key) || 0) + 1;
    const existing = this.map.get(key);
    // Keep the original window: re-stamping the TTL on every message would
    // turn a daily cap into a rolling one that never resets under load.
    this.set(key, current, existing && existing.expiresAt ? existing.expiresAt - Date.now() : ttlMs);
    return current;
  }
}

export const store = new MemoryStore();

// ---- Coaching-credit balance ----------------------------------------------
//
// Balance is microGBP (1,000,000 = £1.00) and never expires — unlike the old
// daily quota, there's no calendar window to reset. Can go negative by the
// cost of one message (the exact cost isn't known until the LLM responds);
// that's expected prepaid-metering behaviour, not a bug.

export function balanceKey(subject) {
  return `balance:${subject}`;
}

export function getBalanceMicros(subject, backing = store) {
  return Number(backing.get(balanceKey(subject)) || 0);
}

export function adjustBalance(subject, deltaMicros, backing = store) {
  const next = Number(backing.get(balanceKey(subject)) || 0) + deltaMicros;
  backing.set(balanceKey(subject), next, null);
  return next;
}

// ---- Purchase idempotency --------------------------------------------------
//
// Keyed by the store transaction/order id alone, never combined with subject:
// the same account legitimately tops up repeatedly, but each individual
// purchase must be creditable exactly once. Check-then-set with no await in
// between (both are synchronous Map ops) so nothing can interleave.

export function creditKey(platform, creditId) {
  return `credited:${platform}:${creditId}`;
}

export function alreadyCredited(platform, creditId, backing = store) {
  return Boolean(backing.get(creditKey(platform, creditId)));
}

export function markCredited(platform, creditId, backing = store) {
  backing.set(creditKey(platform, creditId), true, null);
}

// ---- Browser access codes -------------------------------------------------

const CODE_TTL_MS = 15 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1

export function generateAccessCode(claims, { backing = store, random = defaultRandom } = {}) {
  const body = Array.from({ length: 8 }, () => CODE_ALPHABET[random(CODE_ALPHABET.length)]).join('');
  const code = `INT-${body.slice(0, 4)}-${body.slice(4)}`;
  backing.set(`code:${code}`, claims, CODE_TTL_MS);
  return { code, expiresAt: Date.now() + CODE_TTL_MS };
}

// Single use: redeeming removes it, so a code shared or intercepted after the
// fact is already spent.
export function redeemAccessCode(code, backing = store) {
  const key = `code:${String(code || '').trim().toUpperCase()}`;
  const claims = backing.get(key);
  if (!claims) return null;
  backing.delete(key);
  return claims;
}

function defaultRandom(max) {
  return Math.floor(Math.random() * max);
}
