// Backend hardening: the Apple chain-of-trust checks beyond the pinned root,
// malformed-input handling, outbound timeouts, the OpenAI output cap, the
// global sandbox budget, reports kept out of the ledger, atomic durable
// writes, and token revocation (on refund and by the operator).
//
// Same environment as server.test.js: development mode with the receipt
// bypass on, so endpoint tests inject verification. Where a test needs the
// real production path it flips the relevant config field and restores it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { mkdtempSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.INTENTION_TOKEN_SECRET = 'test-secret-do-not-use';
process.env.INTENTION_LLM_API_KEY = 'test-llm-key';
process.env.INTENTION_LLM_PROVIDER = 'anthropic';
process.env.INTENTION_LLM_MODEL = 'claude-sonnet-5';
process.env.NODE_ENV = 'development';
process.env.INTENTION_ALLOW_UNVERIFIED_RECEIPTS = '1';
process.env.INTENTION_WEBHOOK_SECRET = 'test-webhook-secret';

const { handleRequest } = await import('../server/src/app.js');
const { signToken, subjectFor } = await import('../server/src/tokens.js');
const {
  MemoryStore, FileStore, StoreError, adjustBalance, getBalanceMicros, getCreditRecord,
  getTokenVersion, refundTopUp, markCredited
} = await import('../server/src/store.js');
const {
  verifyAppleJWS, verifyAppleReceipt, decodeJWS, VerificationError,
  APPLE_RECEIPT_SIGNING_OID, APPLE_WWDR_INTERMEDIATE_OID
} = await import('../server/src/apple.js');
const { verifyGooglePurchase } = await import('../server/src/google.js');
const { callCoachLLM } = await import('../server/src/llm.js');
const { Reservations } = await import('../server/src/reservations.js');
const { RateLimiter } = await import('../server/src/ratelimit.js');
const { MemoryReportStore, FileReportStore } = await import('../server/src/reports.js');
const { config, creditMicrosForTopUp, assertBootConfig } = await import('../server/src/config.js');

const SECRET = 'test-secret-do-not-use';
const CREDIT1 = creditMicrosForTopUp('apple', 1);
const PRODUCT1 = 'uk.co.maybeitssoftware.intention.coach.credit1';

const appleResult = { productId: PRODUCT1, creditId: 'txn-1', appAccountToken: 'acct-apple-1' };

const deps = (overrides = {}) => ({
  store: new MemoryStore(),
  reservations: new Reservations(),
  rateLimiter: new RateLimiter(),
  reports: new MemoryReportStore(),
  verifyApple: async () => appleResult,
  verifyGoogle: async () => ({
    productId: 'intention_coach_credit_1', creditId: 'order-1',
    purchaseToken: 'ptoken-1', obfuscatedExternalAccountId: 'acct-google-1'
  }),
  consumeGoogle: async () => {},
  callCoachLLM: async () => ({ text: 'ok', toolCalls: [], usage: { inputTokens: 10, outputTokens: 10 } }),
  ...overrides
});

const post = (path, body, headers = {}, d = deps()) =>
  handleRequest({ method: 'POST', path, headers, body }, d);

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const fakeJWS = (payload, header = { alg: 'ES256' }) => `${b64url(header)}.${b64url(payload)}.sig`;

// Temporarily overrides fields on a config sub-object, restored after each test.
const restorers = [];
function override(target, fields) {
  const saved = Object.fromEntries(Object.keys(fields).map(k => [k, target[k]]));
  Object.assign(target, fields);
  restorers.push(() => Object.assign(target, saved));
}
afterEach(() => {
  while (restorers.length) restorers.pop()();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---- A locally minted StoreKit-shaped chain ---------------------------------
//
// root (CA) -> intermediate (CA, WWDR marker) -> leaf (not CA, receipt-signing
// marker), all ES256. The real Apple root can't be used, so tests pin this
// root via verifyAppleJWS's rootFingerprints option — which is exactly what
// lets every check AFTER the pin be exercised, one broken property at a time.

function der(tag, content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
  if (body.length < 0x80) return Buffer.concat([Buffer.from([tag, body.length]), body]);
  const lengthBytes = [];
  for (let remaining = body.length; remaining > 0; remaining >>= 8) lengthBytes.unshift(remaining & 0xff);
  return Buffer.concat([Buffer.from([tag, 0x80 | lengthBytes.length, ...lengthBytes]), body]);
}

const ECDSA_SHA256 = der(0x30, der(0x06, Buffer.from([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02])));
const BASIC_CONSTRAINTS_OID = der(0x06, Buffer.from([0x55, 0x1d, 0x13]));

function name(cn) {
  return der(0x30, der(0x31, der(0x30, Buffer.concat([
    der(0x06, Buffer.from([0x55, 0x04, 0x03])),
    der(0x0c, Buffer.from(cn))
  ]))));
}

function validity() {
  const fmt = (date) => date.toISOString().replace(/[-:]/g, '').slice(2, 14) + 'Z';
  return der(0x30, Buffer.concat([
    der(0x17, Buffer.from(fmt(new Date(Date.now() - 86400000)))),
    der(0x17, Buffer.from(fmt(new Date(Date.now() + 86400000))))
  ]));
}

function extension(oidTlv, value, critical = false) {
  return der(0x30, Buffer.concat([
    oidTlv,
    ...(critical ? [der(0x01, Buffer.from([0xff]))] : []),
    der(0x04, value)
  ]));
}

const basicConstraints = (ca) =>
  extension(BASIC_CONSTRAINTS_OID, der(0x30, ca ? der(0x01, Buffer.from([0xff])) : Buffer.alloc(0)), true);
// Apple's marker extensions carry an ASN.1 NULL; only their presence matters.
const marker = (oidTlv) => extension(oidTlv, der(0x05, Buffer.alloc(0)));

let serial = 1;
function certificate({ subject, issuer, publicKey, signingKey, extensions = [] }) {
  const tbs = der(0x30, Buffer.concat([
    der(0xa0, der(0x02, Buffer.from([0x02]))),
    der(0x02, Buffer.from([serial++ & 0x7f || 1])),
    ECDSA_SHA256,
    name(issuer), validity(), name(subject),
    publicKey.export({ type: 'spki', format: 'der' }),
    ...(extensions.length ? [der(0xa3, der(0x30, Buffer.concat(extensions)))] : [])
  ]));
  const signature = crypto.sign('sha256', tbs, signingKey);
  return der(0x30, Buffer.concat([tbs, ECDSA_SHA256, der(0x03, Buffer.concat([Buffer.from([0]), signature]))]));
}

const ec = () => crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

// Every property the verifier checks is a switch, so a test can break exactly
// one of them and see that one check, and only it, fire.
function makeChain({
  rootCa = true, intermediateCa = true, leafCa = false,
  wwdrMarker = true, receiptMarker = true
} = {}) {
  const root = ec(), intermediate = ec(), leaf = ec();
  const rootDer = certificate({
    subject: 'Test Root', issuer: 'Test Root', publicKey: root.publicKey, signingKey: root.privateKey,
    extensions: [basicConstraints(rootCa)]
  });
  const intermediateDer = certificate({
    subject: 'Test WWDR', issuer: 'Test Root', publicKey: intermediate.publicKey, signingKey: root.privateKey,
    extensions: [basicConstraints(intermediateCa), ...(wwdrMarker ? [marker(APPLE_WWDR_INTERMEDIATE_OID)] : [])]
  });
  const leafDer = certificate({
    subject: 'Test Receipt Signer', issuer: 'Test WWDR', publicKey: leaf.publicKey, signingKey: intermediate.privateKey,
    extensions: [basicConstraints(leafCa), ...(receiptMarker ? [marker(APPLE_RECEIPT_SIGNING_OID)] : [])]
  });
  const pin = new Set([new crypto.X509Certificate(rootDer).fingerprint256.toUpperCase()]);
  return {
    x5c: [leafDer, intermediateDer, rootDer].map(c => c.toString('base64')),
    leafKey: leaf.privateKey,
    pin
  };
}

function signJWS(payload, chain, header = {}) {
  const h = b64url({ alg: 'ES256', x5c: chain.x5c, ...header });
  const body = b64url(payload);
  const sig = crypto.sign('sha256', Buffer.from(`${h}.${body}`), {
    key: chain.leafKey, dsaEncoding: 'ieee-p1363'
  }).toString('base64url');
  return `${h}.${body}.${sig}`;
}

describe('Apple JWS chain of trust, beyond the pinned root', () => {
  const payload = { transactionId: 't-1', productId: PRODUCT1 };

  it('accepts a well-formed StoreKit-shaped chain', () => {
    const chain = makeChain();
    expect(verifyAppleJWS(signJWS(payload, chain), { rootFingerprints: chain.pin })).toEqual(payload);
  });

  // Apple issues a great many certificates under its roots; only the
  // receipt-signing one may sign a transaction.
  it('rejects a leaf without the receipt-signing marker', () => {
    const chain = makeChain({ receiptMarker: false });
    expect(() => verifyAppleJWS(signJWS(payload, chain), { rootFingerprints: chain.pin }))
      .toThrow(/receipt-signing certificate/);
  });

  it('rejects an intermediate without the WWDR marker', () => {
    const chain = makeChain({ wwdrMarker: false });
    expect(() => verifyAppleJWS(signJWS(payload, chain), { rootFingerprints: chain.pin }))
      .toThrow(/WWDR/);
  });

  it('rejects an intermediate that is not a CA', () => {
    const chain = makeChain({ intermediateCa: false });
    expect(() => verifyAppleJWS(signJWS(payload, chain), { rootFingerprints: chain.pin }))
      .toThrow(VerificationError);
  });

  it('rejects a root that is not a CA', () => {
    const chain = makeChain({ rootCa: false });
    expect(() => verifyAppleJWS(signJWS(payload, chain), { rootFingerprints: chain.pin }))
      .toThrow(VerificationError);
  });

  it('rejects a leaf that is itself a CA', () => {
    const chain = makeChain({ leafCa: true });
    expect(() => verifyAppleJWS(signJWS(payload, chain), { rootFingerprints: chain.pin }))
      .toThrow(/receipt-signing certificate/);
  });

  it('rejects any algorithm but ES256, whatever the signature', () => {
    const chain = makeChain();
    for (const alg of ['HS256', 'none', 'RS256', undefined]) {
      expect(() => verifyAppleJWS(signJWS(payload, chain, { alg }), { rootFingerprints: chain.pin }))
        .toThrow(/ES256/);
    }
  });

  it('rejects a chain that is not exactly leaf, intermediate, root', () => {
    const chain = makeChain();
    const short = { ...chain, x5c: chain.x5c.slice(0, 2) };
    expect(() => verifyAppleJWS(signJWS(payload, short), { rootFingerprints: chain.pin }))
      .toThrow(/malformed/);
  });

  it('rejects a payload signed by a key other than the leaf', () => {
    const chain = makeChain();
    const forged = { ...chain, leafKey: ec().privateKey };
    expect(() => verifyAppleJWS(signJWS(payload, forged), { rootFingerprints: chain.pin }))
      .toThrow(/signature does not match/);
  });
});

describe('malformed Apple JWS is a VerificationError, never a 500', () => {
  const header = b64url({ alg: 'ES256' });
  const body = b64url({ transactionId: 't' });
  const cases = {
    'non-base64 JSON header': `!!!.${body}.sig`,
    'header that is not JSON': `${Buffer.from('not json').toString('base64url')}.${body}.sig`,
    'header that is JSON but not an object': `${b64url('just a string')}.${body}.sig`,
    'payload that is null': `${header}.${b64url(null)}.sig`
  };
  for (const [label, jws] of Object.entries(cases)) {
    it(`decodeJWS: ${label}`, () => {
      expect(() => decodeJWS(jws)).toThrow(VerificationError);
    });
  }

  it('rejects a non-string x5c entry', () => {
    const jws = `${b64url({ alg: 'ES256', x5c: [{}, 1, null] })}.${body}.sig`;
    expect(() => verifyAppleJWS(jws)).toThrow(VerificationError);
  });

  it('rejects x5c entries that are not certificates', () => {
    const jws = `${b64url({ alg: 'ES256', x5c: ['bm90IGEgY2VydA==', 'AAAA', 'zzzz'] })}.${body}.sig`;
    expect(() => verifyAppleJWS(jws)).toThrow(VerificationError);
  });

  it('rejects a signature of the wrong length without a raw crypto error', () => {
    const chain = makeChain();
    const [h, p] = signJWS({ transactionId: 't' }, chain).split('.');
    expect(() => verifyAppleJWS(`${h}.${p}.AAAA`, { rootFingerprints: chain.pin }))
      .toThrow(/signature does not match/);
  });

  it('/v1/entitlement/verify answers a junk receipt with a 401', async () => {
    const res = await post('/v1/entitlement/verify', { platform: 'apple', receipt: `!!!.${body}.sig` }, {},
      deps({ verifyApple: verifyAppleReceipt }));
    expect(res.status).toBe(401);
  });

  it('the Apple webhook answers a junk signedPayload with a 401', async () => {
    const res = await post('/v1/webhooks/apple', { signedPayload: `${b64url([1, 2])}.${body}.sig` });
    expect(res.status).toBe(401);
  });

  it('the Apple webhook answers a junk nested signedTransactionInfo with a 401', async () => {
    const signedPayload = fakeJWS({ notificationType: 'REFUND', data: { signedTransactionInfo: { not: 'a string' } } });
    const res = await post('/v1/webhooks/apple', { signedPayload });
    expect(res.status).toBe(401);
  });
});

describe('Apple verification fails closed without App Store Server API credentials', () => {
  it('refuses a receipt as upstream_unavailable rather than trusting its signature', async () => {
    override(config, { allowUnverifiedReceipts: false });
    override(config.apple, { issuerId: '', keyId: '', privateKey: '' });
    await expect(verifyAppleReceipt(fakeJWS({ transactionId: 't', productId: PRODUCT1 })))
      .rejects.toMatchObject({ code: 'upstream_unavailable' });
  });

  it('and the endpoint answers that with a 503, so the client keeps the receipt', async () => {
    override(config, { allowUnverifiedReceipts: false });
    override(config.apple, { issuerId: '', keyId: '', privateKey: '' });
    const res = await post('/v1/entitlement/verify', { platform: 'apple', receipt: fakeJWS({}) }, {},
      deps({ verifyApple: verifyAppleReceipt }));
    expect(res.status).toBe(503);
  });
});

describe('assertBootConfig and Apple credentials', () => {
  const silent = { warn() {}, error() {} };
  const appleKey = ec().privateKey.export({ type: 'pkcs8', format: 'pem' });

  it('refuses a production boot with any Apple credential missing', () => {
    override(config, { env: 'production' });
    for (const missing of ['issuerId', 'keyId', 'privateKey']) {
      override(config.apple, { issuerId: 'iss', keyId: 'kid', privateKey: appleKey, [missing]: '' });
      expect(assertBootConfig(silent)).toBe(false);
    }
  });

  it('refuses a production boot with an unreadable Apple key', () => {
    override(config, { env: 'production' });
    override(config.apple, { issuerId: 'iss', keyId: 'kid', privateKey: 'not a pem' });
    expect(assertBootConfig(silent)).toBe(false);
  });

  it('boots production with all three present', () => {
    override(config, { env: 'production' });
    override(config.apple, { issuerId: 'iss', keyId: 'kid', privateKey: appleKey });
    expect(assertBootConfig(silent)).toBe(true);
  });

  it('only warns in development', () => {
    override(config.apple, { issuerId: '', keyId: '', privateKey: '' });
    const warn = vi.fn();
    expect(assertBootConfig({ warn, error() {} })).toBe(true);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/Apple receipts will be refused/);
  });
});

// ---- Outbound timeouts ------------------------------------------------------

// A fetch that never answers until its AbortSignal fires.
function hangingFetch() {
  return vi.fn((url, { signal } = {}) => new Promise((_, reject) => {
    signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }));
}

describe('store API calls are bounded by a timeout', () => {
  it('a hung App Store Server API surfaces as upstream_unavailable', async () => {
    vi.useFakeTimers();
    const fetch = hangingFetch();
    vi.stubGlobal('fetch', fetch);
    override(config.apple, {
      issuerId: 'iss', keyId: 'kid', privateKey: ec().privateKey.export({ type: 'pkcs8', format: 'pem' })
    });
    const pending = verifyAppleReceipt(fakeJWS({ transactionId: 't', productId: PRODUCT1 }));
    const assertion = expect(pending).rejects.toMatchObject({ code: 'upstream_unavailable', message: /timed out/ });
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('a hung Google token exchange surfaces as upstream_unavailable', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hangingFetch());
    override(config, { allowUnverifiedReceipts: false });
    override(config.google, {
      clientEmail: 'svc@example.iam.gserviceaccount.com',
      privateKey: crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' })
    });
    const pending = verifyGooglePurchase({ purchaseToken: 'pt', productId: 'intention_coach_credit_1' });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'upstream_unavailable', message: /timed out/ });
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });
});

// ---- LLM output cap ---------------------------------------------------------

describe('the hosted coach caps output on every provider', () => {
  const okFetch = (reply) => vi.fn(async () => ({ ok: true, json: async () => reply }));

  it('sends max_completion_tokens to OpenAI', async () => {
    const fetch = okFetch({ choices: [{ message: { content: 'hi' } }], usage: {} });
    vi.stubGlobal('fetch', fetch);
    await callCoachLLM({ system: 'sys', messages: [{ role: 'user', content: 'hi' }] },
      { provider: 'openai', model: 'gpt-5.6-terra' });
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.max_completion_tokens).toBe(config.llm.maxTokens);
  });

  it('turns GPT-5 reasoning off even with no tools, so it cannot spend the cap thinking', async () => {
    const fetch = okFetch({ choices: [{ message: { content: 'hi' } }], usage: {} });
    vi.stubGlobal('fetch', fetch);
    await callCoachLLM({ system: 'sys', messages: [{ role: 'user', content: 'hi' }], tools: [] },
      { provider: 'openai', model: 'gpt-5.6-terra' });
    expect(JSON.parse(fetch.mock.calls[0][1].body).reasoning_effort).toBe('none');
  });

  it('and still sends max_tokens to Anthropic', async () => {
    const fetch = okFetch({ content: [{ type: 'text', text: 'hi' }], usage: {} });
    vi.stubGlobal('fetch', fetch);
    await callCoachLLM({ system: 'sys', messages: [{ role: 'user', content: 'hi' }] }, { provider: 'anthropic' });
    expect(JSON.parse(fetch.mock.calls[0][1].body).max_tokens).toBe(config.llm.maxTokens);
  });
});

// ---- Global sandbox budget --------------------------------------------------

describe('sandbox credit has a daily budget across every subject', () => {
  // Each purchase under a brand-new account UUID — a fresh subject, and so a
  // fresh per-subject cap. That is the attack the daily budget exists for.
  const sandboxAs = (n) => ({
    ...appleResult, environment: 'sandbox', creditId: `sbx-${n}`, appAccountToken: `fresh-uuid-${n}`
  });
  const buy = (store, n) => post('/v1/entitlement/verify', { platform: 'apple', receipt: 'jws' }, {},
    deps({ store, verifyApple: async () => sandboxAs(n) }));

  it('stops crediting fresh subjects once the day\'s budget is spent', async () => {
    const store = new MemoryStore();
    const days = config.apple.sandboxDailyBudgetGbp / config.apple.sandboxCreditCapGbp;
    for (let i = 0; i < days; i++) {
      expect((await buy(store, i)).body.balanceMicros).toBe(CREDIT1);
    }
    const over = await buy(store, 'over');
    expect(over.status).toBe(200); // still a success, exactly as past the per-subject cap
    expect(over.body.balanceMicros).toBe(0);
  });

  it('clamps the purchase that crosses the budget to what is left of it', async () => {
    override(config.apple, { sandboxDailyBudgetGbp: 1.5 });
    const store = new MemoryStore();
    await buy(store, 1);
    const res = await buy(store, 2);
    expect(res.body.balanceMicros).toBe(creditMicrosForTopUp('apple', 1.5) - CREDIT1);
  });

  it('resets on the next UTC day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-01T12:00:00Z'));
    override(config.apple, { sandboxDailyBudgetGbp: 1 });
    const store = new MemoryStore();
    await buy(store, 1);
    expect((await buy(store, 2)).body.balanceMicros).toBe(0);
    vi.setSystemTime(new Date('2026-03-02T00:00:01Z'));
    expect((await buy(store, 3)).body.balanceMicros).toBe(CREDIT1);
  });

  it('never limits a production purchase', async () => {
    override(config.apple, { sandboxDailyBudgetGbp: 1 });
    const store = new MemoryStore();
    await buy(store, 1);
    const res = await post('/v1/entitlement/verify', { platform: 'apple', receipt: 'jws' }, {},
      deps({ store, verifyApple: async () => ({ ...appleResult, creditId: 'real-1', environment: 'production' }) }));
    expect(res.body.balanceMicros).toBe(CREDIT1);
  });

  it('0 refuses sandbox credit outright', async () => {
    override(config.apple, { sandboxDailyBudgetGbp: 0 });
    expect((await buy(new MemoryStore(), 1)).body.balanceMicros).toBe(0);
  });
});

// ---- Reports out of the ledger ----------------------------------------------

describe('coach reports have their own bounded store', () => {
  const tmp = () => join(mkdtempSync(join(tmpdir(), 'intention-reports-')), 'reports.jsonl');

  it('the memory store keeps only the most recent N', () => {
    const reports = new MemoryReportStore({ maxRecords: 3 });
    for (let i = 0; i < 5; i++) reports.add({ i });
    expect(reports.records.map(r => r.i)).toEqual([2, 3, 4]);
  });

  it('the file store appends one JSON line per report', () => {
    const file = tmp();
    const reports = new FileReportStore(file);
    reports.add({ reported: 'a' });
    reports.add({ reported: 'b' });
    expect(readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse)).toEqual([{ reported: 'a' }, { reported: 'b' }]);
  });

  it('rotates rather than growing past its byte cap, keeping the newest', () => {
    const file = tmp();
    const reports = new FileReportStore(file, { maxBytes: 200 });
    for (let i = 0; i < 20; i++) reports.add({ i, pad: 'x'.repeat(40) });
    expect(statSync(file).size).toBeLessThanOrEqual(200);
    expect(statSync(`${file}.1`).size).toBeLessThanOrEqual(200);
    const newest = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse).at(-1);
    expect(newest.i).toBe(19);
  });

  it('picks up its size across a restart', () => {
    const file = tmp();
    new FileReportStore(file, { maxBytes: 200 }).add({ pad: 'x'.repeat(150) });
    const again = new FileReportStore(file, { maxBytes: 200 });
    again.add({ pad: 'y'.repeat(150) });
    expect(existsSync(`${file}.1`)).toBe(true);
  });

  it('a report never writes the durable ledger', async () => {
    const stateFile = join(mkdtempSync(join(tmpdir(), 'intention-state-')), 'state.json');
    const store = new FileStore(stateFile);
    const persist = vi.spyOn(store, 'persist');
    const res = await post('/v1/report', { reported: 'something' }, {}, deps({ store }));
    expect(res.status).toBe(200);
    expect(persist).not.toHaveBeenCalled();
  });
});

// ---- Durable writes are atomic ----------------------------------------------

describe('a failed state-file write leaves memory exactly as it was', () => {
  const stateFile = () => join(mkdtempSync(join(tmpdir(), 'intention-state-')), 'state.json');
  const diskFull = (store) => vi.spyOn(store, 'persist').mockImplementation(() => {
    throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  });

  it('a single set rolls back and throws StoreError', () => {
    const store = new FileStore(stateFile());
    store.set('k', 'before', null);
    diskFull(store);
    expect(() => store.set('k', 'after', null)).toThrow(StoreError);
    expect(() => store.set('fresh', 1, null)).toThrow(StoreError);
    expect(store.get('k')).toBe('before');
    expect(store.get('fresh')).toBe(null);
  });

  it('a batch rolls back every key it touched', () => {
    const store = new FileStore(stateFile());
    store.set('a', 1, null);
    diskFull(store);
    expect(() => store.batch(() => {
      store.set('a', 2, null);
      store.set('b', 2, null);
      store.delete('a');
    })).toThrow(StoreError);
    expect(store.get('a')).toBe(1);
    expect(store.get('b')).toBe(null);
  });

  it('a batch persists once, not once per write', () => {
    const store = new FileStore(stateFile());
    const persist = vi.spyOn(store, 'persist');
    store.batch(() => { store.set('a', 1, null); store.set('b', 2, null); store.increment('c'); });
    expect(persist).toHaveBeenCalledTimes(1);
  });

  // The divergence this exists to close: the credit marker used to land in
  // memory and then the flush fail, so the purchase read as credited with no
  // balance behind it, and every retry added nothing.
  it('a credit whose write fails is a 503 with nothing recorded, and the retry credits once', async () => {
    const file = stateFile();
    const store = new FileStore(file);
    const persist = diskFull(store);
    const failed = await post('/v1/entitlement/verify', { platform: 'apple', receipt: 'jws' }, {}, deps({ store }));
    expect(failed.status).toBe(503);
    expect(failed.body.code).toBe('store_unavailable');
    expect(getCreditRecord('apple', 'txn-1', store)).toBe(null);
    expect(getBalanceMicros(subjectFor('apple', 'acct-apple-1'), store)).toBe(0);

    persist.mockRestore();
    const retried = await post('/v1/entitlement/verify', { platform: 'apple', receipt: 'jws' }, {}, deps({ store }));
    expect(retried.status).toBe(200);
    expect(retried.body.balanceMicros).toBe(CREDIT1);
    expect(getBalanceMicros(subjectFor('apple', 'acct-apple-1'), new FileStore(file))).toBe(CREDIT1);
  });

  it('a refund whose write fails leaves the credit and the token version untouched', () => {
    const store = new FileStore(stateFile());
    adjustBalance('sub-r', CREDIT1, store);
    markCredited('apple', 'txn-r', { subject: 'sub-r', productId: PRODUCT1, creditMicros: CREDIT1, refunded: false }, store);
    diskFull(store);
    expect(() => refundTopUp('apple', 'txn-r', {}, store)).toThrow(StoreError);
    expect(getBalanceMicros('sub-r', store)).toBe(CREDIT1);
    expect(getCreditRecord('apple', 'txn-r', store).refunded).toBe(false);
    expect(getTokenVersion('sub-r', store)).toBe(0);
  });
});

// ---- Token revocation -------------------------------------------------------

describe('a refund revokes the subject\'s tokens', () => {
  const chat = (token, d) => post('/v1/chat', { messages: [{ role: 'user', content: 'hi' }] },
    { authorization: `Bearer ${token}` }, d);

  it('on an Apple refund notification', async () => {
    const d = deps();
    const verified = await post('/v1/entitlement/verify', { platform: 'apple', receipt: 'jws' }, {}, d);
    const sub = subjectFor('apple', 'acct-apple-1');
    adjustBalance(sub, CREDIT1, d.store); // so a surviving token would otherwise still chat

    const signedPayload = fakeJWS({
      notificationType: 'REFUND',
      data: { signedTransactionInfo: fakeJWS({ transactionId: 'txn-1', appAccountToken: 'acct-apple-1', productId: PRODUCT1 }) }
    });
    expect((await post('/v1/webhooks/apple', { signedPayload }, {}, d)).status).toBe(200);
    expect(getTokenVersion(sub, d.store)).toBe(1);
    expect((await chat(verified.body.token, d)).status).toBe(401);
    expect((await post('/v1/entitlement/refresh', { token: verified.body.token }, {}, d)).status).toBe(401);
  });

  it('on a Google voided-purchase notification', async () => {
    const d = deps();
    await post('/v1/entitlement/verify', { platform: 'google', receipt: { purchaseToken: 'ptoken-1' } }, {}, d);
    const data = Buffer.from(JSON.stringify({ voidedPurchaseNotification: { purchaseToken: 'ptoken-1', orderId: 'order-1' } })).toString('base64');
    const res = await post('/v1/webhooks/google', { message: { data } },
      { authorization: 'Bearer test-webhook-secret' }, d);
    expect(res.status).toBe(200);
    expect(getTokenVersion(subjectFor('google', 'acct-google-1'), d.store)).toBe(1);
  });

  it('but a refund that claws back nothing revokes nothing', () => {
    const store = new MemoryStore();
    refundTopUp('apple', 'never-credited', { subject: 'sub-x' }, store);
    expect(getTokenVersion('sub-x', store)).toBe(0);
  });

  it('and recovery never revokes', async () => {
    const d = deps({ verifyApple: async () => ({ ...appleResult, appAccountToken: 'aaaaaaaa-1111' }) });
    const verified = await post('/v1/entitlement/verify', { platform: 'apple', receipt: 'jws' }, {}, d);
    const recovered = await post('/v1/entitlement/recover', { platform: 'apple', accountToken: 'aaaaaaaa-1111' }, {}, d);
    expect(recovered.status).toBe(200);
    expect(getTokenVersion(subjectFor('apple', 'aaaaaaaa-1111'), d.store)).toBe(0);
    expect((await chat(verified.body.token, d)).status).toBe(200);
  });
});

describe('POST /v1/admin/revoke', () => {
  const ADMIN = 'a'.repeat(48);
  const admin = { authorization: `Bearer ${ADMIN}` };
  const sub = subjectFor('apple', 'acct-admin-1');
  const tokenFor = (d) => signToken({ sub, platform: 'apple', productId: PRODUCT1, tv: getTokenVersion(sub, d.store) }, SECRET, 60_000);

  beforeEach(() => override(config, { adminSecret: ADMIN }));

  it('does not exist unless a long admin secret is configured', async () => {
    override(config, { adminSecret: '' });
    expect((await post('/v1/admin/revoke', { subject: sub }, admin)).status).toBe(404);
    override(config, { adminSecret: 'short' });
    expect((await post('/v1/admin/revoke', { subject: sub }, { authorization: 'Bearer short' })).status).toBe(404);
  });

  it('refuses a wrong or missing secret', async () => {
    expect((await post('/v1/admin/revoke', { subject: sub }, { authorization: `Bearer ${'b'.repeat(48)}` })).status).toBe(401);
    expect((await post('/v1/admin/revoke', { subject: sub })).status).toBe(401);
  });

  it('revokes every outstanding token for the subject, leaving the balance alone', async () => {
    const d = deps();
    adjustBalance(sub, CREDIT1, d.store);
    const token = tokenFor(d);
    const res = await post('/v1/admin/revoke', { subject: sub }, admin, d);
    expect(res.status).toBe(200);
    expect(res.body.tokenVersion).toBe(1);
    const chat = await post('/v1/chat', { messages: [{ role: 'user', content: 'hi' }] }, { authorization: `Bearer ${token}` }, d);
    expect(chat.status).toBe(401);
    expect(getBalanceMicros(sub, d.store)).toBe(CREDIT1);
  });

  it('derives the subject from platform + accountToken', async () => {
    const d = deps();
    const res = await post('/v1/admin/revoke', { platform: 'apple', accountToken: 'acct-admin-1' }, admin, d);
    expect(res.body.subject).toBe(sub);
    expect(getTokenVersion(sub, d.store)).toBe(1);
  });

  it('refuses a body that names no well-formed subject', async () => {
    expect((await post('/v1/admin/revoke', { subject: 'nope' }, admin)).status).toBe(400);
    expect((await post('/v1/admin/revoke', {}, admin)).status).toBe(400);
  });
});
