import crypto from 'node:crypto';
import { readFileSync, writeSync, renameSync, openSync, fsyncSync, closeSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config, findTopUp, creditMicrosForTopUp } from './config.js';
import { logEvent } from './log.js';

// Small pieces of server state: the coaching-credit balance ledger, the
// idempotency record that stops a top-up being credited twice, and the
// one-time codes that link a browser to credit bought in a mobile app.
//
// Two backings share one four-method interface. MemoryStore (the default —
// tests and local dev stay hermetic, no file appears) keeps everything in a
// Map and loses it on restart. FileStore layers synchronous persistence on
// top, selected by INTENTION_STATE_FILE, so a redeploy no longer wipes paid
// balances and re-arms every store receipt for re-crediting.
//
// THE GOVERNING CONSTRAINT: all four methods are synchronous, and callers
// depend on that — chatEndpoint's balance reservation and creditTopUp's
// check-then-set are only race-free because there is no await between the
// check and the write (see reservations.js). Any replacement backing that
// forces callers to become async silently reopens those races. If this ever
// outgrows one process, the swap target is a synchronous embedded store
// (node:sqlite's DatabaseSync), not Redis.

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

// Durable variant: the in-memory Map stays the authoritative synchronous
// read/write path (preserving the constraint above), and every mutation is
// flushed to disk before the call returns — write temp, fsync, rename, so the
// file on disk is always either the old state or the new one, never partial.
//
// Synchronous-on-every-mutation is affordable because the durable store only
// ever sees rare writes: purchases, refunds, one deduction per chat message,
// the occasional access code. High-churn counters (rate limiting) must go in
// a separate always-in-memory MemoryStore, never here — losing them on
// restart is fine, and keeping them out is what keeps this fsync-per-write.
export class FileStore extends MemoryStore {
  constructor(filePath) {
    super();
    this.filePath = filePath;
    mkdirSync(dirname(filePath), { recursive: true });
    this.load();
  }

  load() {
    let raw;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return; // first boot on a fresh volume
      throw e;
    }
    // A parse failure throws and stops boot on purpose: starting empty would
    // silently zero balances and re-arm every receipt — the exact failure
    // this store exists to prevent. The atomic write below means the file is
    // never half-written by us, so corruption here needs an operator anyway.
    const entries = JSON.parse(raw);
    const now = Date.now();
    for (const { key, value, expiresAt } of entries) {
      if (expiresAt && expiresAt < now) continue;
      this.map.set(key, { value, expiresAt: expiresAt || 0 });
    }
  }

  persist() {
    const now = Date.now();
    const entries = [];
    for (const [key, entry] of this.map) {
      if (entry.expiresAt && entry.expiresAt < now) continue;
      entries.push({ key, value: entry.value, expiresAt: entry.expiresAt || 0 });
    }
    const tmp = `${this.filePath}.tmp`;
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, JSON.stringify(entries));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.filePath);
    // fsync the directory too, or the rename itself can be lost on power cut.
    try {
      const dirFd = openSync(dirname(this.filePath), 'r');
      fsyncSync(dirFd);
      closeSync(dirFd);
    } catch (e) {} // not supported on some platforms; rename already landed
  }

  set(key, value, ttlMs) {
    super.set(key, value, ttlMs);
    this.persist();
  }

  delete(key) {
    super.delete(key);
    this.persist();
  }

  increment(key, ttlMs) {
    const current = super.increment(key, ttlMs);
    this.persist();
    return current;
  }
}

export const store = config.stateFile ? new FileStore(config.stateFile) : new MemoryStore();

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
  // The audit line lives here, in the one place every credit movement passes
  // through — top-ups, chat deductions and refund clawbacks all leave a trail.
  logEvent('balance_adjust', { subject, deltaMicros, balanceMicros: next });
  return next;
}

// ---- Purchase idempotency & refund tracking --------------------------------
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

export function markCredited(platform, creditId, dataOrBacking = true, backing = store) {
  let data = dataOrBacking;
  let storeToUse = backing;
  if (dataOrBacking && typeof dataOrBacking === 'object' && typeof dataOrBacking.get === 'function' && typeof dataOrBacking.set === 'function') {
    data = true;
    storeToUse = dataOrBacking;
  }
  storeToUse.set(creditKey(platform, creditId), data, null);
}

export function getCreditRecord(platform, creditId, backing = store) {
  const val = backing.get(creditKey(platform, creditId));
  if (!val) return null;
  if (val === true) return { credited: true };
  return val;
}

export function refundTopUp(platform, creditId, { subject = null, productId = null, creditMicros = null } = {}, backing = store) {
  const existing = getCreditRecord(platform, creditId, backing);

  // A refund for a purchase that was never credited must not write anything:
  // recording it would poison the idempotency key, so a later legitimate
  // verify would see alreadyCredited and silently grant nothing.
  if (!existing) {
    return {
      refunded: false,
      noCreditRecord: true,
      subject,
      deductedMicros: 0,
      balanceMicros: subject ? getBalanceMicros(subject, backing) : 0
    };
  }

  if (existing && typeof existing === 'object' && existing.refunded) {
    const s = existing.subject || subject;
    return {
      alreadyRefunded: true,
      subject: s,
      balanceMicros: s ? getBalanceMicros(s, backing) : 0
    };
  }

  const targetSubject = subject || (existing && typeof existing === 'object' ? existing.subject : null);
  const targetProductId = productId || (existing && typeof existing === 'object' ? existing.productId : null);

  let microsToDeduct = creditMicros;
  if (microsToDeduct === null || microsToDeduct === undefined) {
    if (existing && typeof existing === 'object' && existing.creditMicros !== undefined) {
      microsToDeduct = existing.creditMicros;
    } else if (targetProductId) {
      const topUp = findTopUp(platform, targetProductId);
      microsToDeduct = topUp ? creditMicrosForTopUp(platform, topUp.priceGbp) : 0;
    } else {
      microsToDeduct = 0;
    }
  }

  let newBalance = 0;
  if (targetSubject && microsToDeduct > 0) {
    newBalance = adjustBalance(targetSubject, -microsToDeduct, backing);
  } else if (targetSubject) {
    newBalance = getBalanceMicros(targetSubject, backing);
  }

  const record = {
    ...(typeof existing === 'object' ? existing : {}),
    credited: true,
    refunded: true,
    refundedAt: Date.now(),
    subject: targetSubject,
    productId: targetProductId,
    creditMicros: microsToDeduct
  };

  markCredited(platform, creditId, record, backing);

  if (record.purchaseToken && record.purchaseToken !== creditId) {
    markCredited(platform, record.purchaseToken, record, backing);
  }
  if (record.orderId && record.orderId !== creditId) {
    markCredited(platform, record.orderId, record, backing);
  }

  return {
    refunded: true,
    subject: targetSubject,
    deductedMicros: microsToDeduct,
    balanceMicros: newBalance
  };
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

// CSPRNG, not Math.random(): V8's PRNG state is recoverable from a few
// observed outputs, so one legitimately minted code could leak the generator
// and make every other live code predictable.
function defaultRandom(max) {
  return crypto.randomInt(max);
}

// ---- Token revocation -----------------------------------------------------
//
// A per-subject integer stamped into every issued token and checked on every
// verify. Bumping it invalidates all of a subject's outstanding tokens at
// once — constant storage, unlike a jti denylist. Absent record means
// version 0, which is also what pre-versioning tokens carry.

export function getTokenVersion(subject, backing = store) {
  return Number(backing.get(`tv:${subject}`) || 0);
}

export function bumpTokenVersion(subject, backing = store) {
  const next = getTokenVersion(subject, backing) + 1;
  backing.set(`tv:${subject}`, next, null);
  return next;
}

