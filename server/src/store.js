// Small pieces of server state: the daily message quota, and the one-time
// codes that link a browser to a subscription bought in a mobile app.
//
// Both are in-memory by design — a single process is enough to run this, and
// neither is worth a database on its own. Swap MemoryStore for a Redis/KV
// implementation of the same four methods when running more than one instance;
// nothing else has to change.

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

const DAY_MS = 24 * 60 * 60 * 1000;

export function quotaKey(subject, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  return `quota:${day}:${subject}`;
}

// Returns { allowed, used, limit }.
export function consumeQuota(subject, limit, backing = store) {
  const key = quotaKey(subject);
  const used = backing.increment(key, DAY_MS);
  return { allowed: used <= limit, used, limit };
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
