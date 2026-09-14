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

  // Drop every expired entry. get() already evicts one on the way past, but
  // only for a key somebody comes back to ask about — so a key written once
  // and never read again stays in the Map for the life of the process. That is
  // fine for the durable store (FileStore.persist filters on every write, and
  // its keys are mostly permanent anyway) and not fine for the rate limiter,
  // whose keys are per-IP and unbounded: one entry per address ever seen,
  // never released. Callers decide when to pay for it; see ratelimit.js.
  sweep(now = Date.now()) {
    let removed = 0;
    for (const [key, entry] of this.map) {
      if (entry.expiresAt && entry.expiresAt < now) {
        this.map.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  get size() {
    return this.map.size;
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

// Presence, not value. A subject who has spent right down to exactly 0 still
// has a record here — adjustBalance always writes — and must still be able to
// recover, or their next top-up would land in a second, freshly-hashed balance
// and the credit they just bought would look like it vanished. A UUID nobody
// has ever purchased under has no record at all, which is the only thing
// /v1/entitlement/recover is allowed to distinguish.
export function hasBalanceRecord(subject, backing = store) {
  const record = backing.get(balanceKey(subject));
  return record !== null && record !== undefined;
}

export function adjustBalance(subject, deltaMicros, backing = store) {
  const next = Number(backing.get(balanceKey(subject)) || 0) + deltaMicros;
  backing.set(balanceKey(subject), next, null);
  // The audit line lives here, in the one place every credit movement passes
  // through — top-ups, chat deductions and refund clawbacks all leave a trail.
  logEvent('balance_adjust', { subject, deltaMicros, balanceMicros: next });
  return next;
}

// ---- Sandbox credit ledger --------------------------------------------------
//
// How much of a subject's balance came from sandbox purchases, which are free
// and repeatable and so have to be capped (config.sandboxCreditCapMicros). Its
// own counter rather than a scan of the credit records: the cap is a running
// total consulted on every top-up, and it must not quietly reset if a record
// is ever pruned. Deliberately never decremented on refund — a sandbox refund
// costs the buyer nothing, so letting it restore headroom would hand back an
// unlimited faucet one refund at a time.

export function sandboxCreditKey(subject) {
  return `sandboxCredit:${subject}`;
}

export function getSandboxCreditMicros(subject, backing = store) {
  return Number(backing.get(sandboxCreditKey(subject)) || 0);
}

export function addSandboxCreditMicros(subject, micros, backing = store) {
  const next = getSandboxCreditMicros(subject, backing) + micros;
  backing.set(sandboxCreditKey(subject), next, null);
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
  // The subject's token version at mint time rides along, so redemption can
  // be checked against revocation the same way a bearer is — see the note on
  // generateRecoveryCode below. Fifteen minutes makes this nearly moot for
  // this code kind, but a revocation lever that works on one code and not the
  // other is the kind of asymmetry nobody remembers at three in the morning.
  backing.set(`code:${code}`, { ...claims, tv: getTokenVersion(claims.sub, backing) }, CODE_TTL_MS);
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

// ---- Recovery codes -------------------------------------------------------
//
// The access code above links a browser to a phone that is sitting in front of
// you right now, so it is single-use and lives fifteen minutes. This one
// answers a different question: the phone is gone. A reinstall keeps the
// account UUID (Keychain kSecAttrSynchronizable on Apple, Auto Backup of
// intention_billing.xml on Android) but a *new* device, or a wiped one, keeps
// nothing — and the consumable receipt that originally bought the credit was
// consumed at purchase and cannot be replayed. A recovery code is the only
// artefact the user can carry across that gap, so it is written down on paper
// and has to still work a year later, on more than one device.
//
// Hence the three differences from `code:`: a ~13-month TTL pushed back out
// as it is used (an active user's code never dies; an abandoned one
// eventually does), multi-use, and 16 body characters instead of 8. The short
// code's 40 bits are safe only because its live pool is tiny and its window
// is minutes; a year-long multi-use pool needs the 80.
export const RECOVERY_CODE_TTL_MS = 400 * 24 * 60 * 60 * 1000;
export const RECOVERY_BODY_LEN = 16;

// How stale a stamp has to get before a read is allowed to write.
//
// "Re-stamped on every use" was the wrong reading of the requirement. The two
// records are re-stamped through *two* backing.set calls, and on FileStore
// each one serialises and fsyncs the entire ledger (see the note above
// FileStore: the durable store "only ever sees rare writes"). But the read
// paths here are not rare — the idempotent lookup runs on every Settings
// open, and lookupRecoveryCode runs on every unauthenticated redeem attempt,
// which is 30/hour/IP. Two whole-ledger fsyncs apiece is disk-write
// amplification on exactly the routes that must not have any.
//
// What the re-stamp is actually for is "an active user's code never dies",
// and against a 400-day TTL a week of resolution is indistinguishable from a
// millisecond's. So a read re-stamps at most once a week and is otherwise
// genuinely read-only.
export const RECOVERY_RESTAMP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export function recoveryKey(code) {
  return `recovery:${code}`;
}

// The reverse mapping, so Settings can re-show the *same* code every time the
// page is opened. Without it every visit would mint another live secret for
// the same balance, and the piece of paper the user already has would be one
// of a growing pile we can never revoke.
export function recoveryOwnerKey(subject) {
  return `recoveryOf:${subject}`;
}

export function getRecoveryCode(subject, backing = store) {
  return backing.get(recoveryOwnerKey(subject)) || null;
}

// Would generateRecoveryCode return an existing code rather than mint one?
// Both records have to be there, which is the same condition the read path
// below tests — restated here so the caller that decides whether to charge
// the mint throttle (app.js's recoveryCodeEndpoint) cannot drift from it.
export function hasRecoveryCode(subject, backing = store) {
  const code = getRecoveryCode(subject, backing);
  return Boolean(code && backing.get(recoveryKey(code)));
}

// Idempotent by default: the same subject gets the same code back, and that
// read costs a write only if the stamp has gone stale (touchRecovery).
// `rotate` is the "I wrote it on something I then lost" path — it deletes the
// old code first, so the new one is genuinely a replacement rather than a
// second key to the same balance.
export function generateRecoveryCode(claims, { backing = store, random = defaultRandom, rotate = false } = {}) {
  const existing = getRecoveryCode(claims.sub, backing);
  if (existing && !rotate) {
    const record = backing.get(recoveryKey(existing));
    if (record) return touchRecovery(existing, record, backing);
  }
  if (existing) backing.delete(recoveryKey(existing));

  const body = Array.from({ length: RECOVERY_BODY_LEN }, () => CODE_ALPHABET[random(CODE_ALPHABET.length)]).join('');
  const code = `INT-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}-${body.slice(12)}`;
  const record = {
    sub: claims.sub,
    platform: claims.platform,
    productId: claims.productId || '',
    createdAt: Date.now(),
    // The subject's token version at mint time. Redemption goes through
    // entitlementResponse, which re-reads the *current* version to stamp the
    // token it issues — so without this the code would keep working after
    // bumpTokenVersion, and the revocation lever would be dead on the one
    // credential that outlives every token. Captured here, checked in
    // app.js's redeemEndpoint.
    tv: getTokenVersion(claims.sub, backing)
  };
  return writeRecovery(code, record, backing);
}

// Multi-use and non-destructive — the opposite of redeemAccessCode. Deleting
// on redemption would mean a user who reinstalls twice is stranded the second
// time, which is precisely the failure this exists to end. The TTL is pushed
// back out on the way past instead, though not on every single pass — see
// touchRecovery, and note that this one runs on an unauthenticated route.
export function lookupRecoveryCode(code, backing = store) {
  const normalized = String(code || '').trim().toUpperCase();
  const record = backing.get(recoveryKey(normalized));
  if (!record) return null;
  touchRecovery(normalized, record, backing);
  return record;
}

// Both records always move together: if the owner mapping expired while the
// code itself lived, the next visit to Settings would mint a second code and
// silently orphan the one on the user's paper. So there is exactly one place
// that writes either of them.
function writeRecovery(code, record, backing) {
  const stamped = { ...record, stampedAt: Date.now() };
  backing.set(recoveryKey(code), stamped, RECOVERY_CODE_TTL_MS);
  backing.set(recoveryOwnerKey(stamped.sub), code, RECOVERY_CODE_TTL_MS);
  return recoveryResult(code, stamped);
}

// The read path. Writes only when the stamp has gone stale enough to be worth
// a pair of whole-ledger fsyncs (RECOVERY_RESTAMP_INTERVAL_MS), and reports
// the expiry the records actually carry rather than the one a write would
// have given them. `createdAt` is the fallback for records minted before
// stampedAt existed — their first stale read upgrades them.
function touchRecovery(code, record, backing) {
  const stampedAt = Number(record.stampedAt) || Number(record.createdAt) || 0;
  if (Date.now() - stampedAt >= RECOVERY_RESTAMP_INTERVAL_MS) {
    return writeRecovery(code, record, backing);
  }
  return recoveryResult(code, record, stampedAt);
}

function recoveryResult(code, record, stampedAt = Date.now()) {
  return { code, createdAt: record.createdAt, expiresAt: stampedAt + RECOVERY_CODE_TTL_MS };
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
