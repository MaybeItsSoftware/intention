// Backend tests: entitlement tokens, the verify/refresh/redeem endpoints, the
// coaching-credit balance ledger, and the coaching proxy's input validation.
//
// The store verifications (Apple JWS, Play Developer API) are injected for
// the endpoint tests below; apple.js's/google.js's own payload-shape
// validation is exercised directly further down using the
// INTENTION_ALLOW_UNVERIFIED_RECEIPTS dev bypass (skips signature/network
// checks, not the payload validation those functions do around it).
// apple.js's certificate chain-of-trust walk is exercised separately with a
// locally generated (deliberately untrusted) chain.

import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.INTENTION_TOKEN_SECRET = 'test-secret-do-not-use';
process.env.INTENTION_LLM_API_KEY = 'test-llm-key';
process.env.NODE_ENV = 'development';
process.env.INTENTION_ALLOW_UNVERIFIED_RECEIPTS = '1';
// The Google refund webhook now fails closed without this, since it deducts
// credit — so an unconfigured secret must never mean "no auth required".
process.env.INTENTION_WEBHOOK_SECRET = 'test-webhook-secret';

const { handleRequest } = await import('../server/src/app.js');
const { signToken, verifyToken, subjectFor } = await import('../server/src/tokens.js');
const {
  MemoryStore, FileStore, adjustBalance, getBalanceMicros, alreadyCredited, markCredited, refundTopUp, getCreditRecord
} = await import('../server/src/store.js');
const { verifyAppleJWS, decodeJWS, verifyAppleReceipt, VerificationError } = await import('../server/src/apple.js');
const { verifyGooglePurchase } = await import('../server/src/google.js');
const { Reservations } = await import('../server/src/reservations.js');
const { RateLimiter } = await import('../server/src/ratelimit.js');
const { UpstreamError } = await import('../server/src/llm.js');
const { creditMicrosForTopUp } = await import('../server/src/config.js');

const SECRET = 'test-secret-do-not-use';
const WEBHOOK_SECRET = 'test-webhook-secret';
const webhookAuth = { authorization: `Bearer ${WEBHOOK_SECRET}` };

// What the £1 tier actually credits once the default store commission (15%)
// and top-up skim (20%) both come off — not the £1 face value 1:1.
const CREDIT1 = creditMicrosForTopUp('apple', 1);

// Matches config.js's default topUps table (£1 tier).
const appleResult = {
  productId: 'uk.co.maybeitssoftware.intention.coach.credit1',
  creditId: 'txn-1',
  appAccountToken: 'acct-apple-1'
};
const googleResult = {
  productId: 'intention_coach_credit_1',
  creditId: 'order-1',
  purchaseToken: 'ptoken-1',
  obfuscatedExternalAccountId: 'acct-google-1'
};

const deps = (overrides = {}) => ({
  store: new MemoryStore(),
  // Fresh per test: holds and rate-limit counters are in-process state, so
  // sharing them would let one test's traffic throttle another's.
  reservations: new Reservations(),
  rateLimiter: new RateLimiter(),
  verifyApple: async () => appleResult,
  verifyGoogle: async () => googleResult,
  consumeGoogle: async () => {},
  callCoachLLM: async () => ({ text: 'ok', toolCalls: [], usage: { inputTokens: 1000, outputTokens: 1000 } }),
  ...overrides
});

const post = (path, body, headers = {}, d = deps()) =>
  handleRequest({ method: 'POST', path, headers, body }, d);

function fakeJWS(payload, header = { alg: 'ES256' }) {
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${enc(header)}.${enc(payload)}.sig`;
}

describe('entitlement tokens', () => {
  it('round-trips a payload', () => {
    const token = signToken({ sub: 'abc' }, SECRET, 60_000);
    expect(verifyToken(token, SECRET).sub).toBe('abc');
  });

  it('rejects a tampered payload', () => {
    const token = signToken({ sub: 'abc' }, SECRET, 60_000);
    const [prefix, payload, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'someone-else', exp: Date.now() + 60_000 })).toString('base64url');
    expect(() => verifyToken(`${prefix}.${forged}.${sig}`, SECRET)).toThrow(/signature/i);
  });

  // A wrong-length signature would make timingSafeEqual throw, which used to
  // surface as a 500 rather than a clean 401.
  it('rejects a signature of the wrong length without throwing a raw error', () => {
    const token = signToken({ sub: 'abc' }, SECRET, 60_000);
    const [prefix, payload] = token.split('.');
    expect(() => verifyToken(`${prefix}.${payload}.aaaa`, SECRET)).toThrow(/signature/i);
  });

  it('rejects an expired token with its own code', () => {
    const token = signToken({ sub: 'abc', exp: Date.now() - 1 }, SECRET, 0);
    expect(() => verifyToken(token, SECRET)).toThrow(/expired/i);
  });

  it('rejects a token signed with a different secret', () => {
    const token = signToken({ sub: 'abc' }, 'other-secret', 60_000);
    expect(() => verifyToken(token, SECRET)).toThrow();
  });

  it('derives a stable, non-reversible subject', () => {
    expect(subjectFor('apple', '123')).toBe(subjectFor('apple', '123'));
    expect(subjectFor('apple', '123')).not.toBe(subjectFor('google', '123'));
    expect(subjectFor('apple', '123')).not.toContain('123');
  });
});

describe('POST /v1/entitlement/verify', () => {
  it('mints a token and credits the top-up for a verified Apple receipt', async () => {
    const res = await post('/v1/entitlement/verify', { platform: 'apple', receipt: 'jws' });
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(true);
    expect(res.body.productId).toBe(appleResult.productId);
    expect(res.body.balanceMicros).toBe(CREDIT1);
    expect(res.body.balanceGbp).toBeLessThan(1); // net of store commission + skim, not the £1 face value
    expect(verifyToken(res.body.token, SECRET).platform).toBe('apple');
  });

  it('credits exactly once for a repeated receipt', async () => {
    const d = deps();
    await post('/v1/entitlement/verify', { platform: 'apple', receipt: 'jws' }, {}, d);
    const res = await post('/v1/entitlement/verify', { platform: 'apple', receipt: 'jws' }, {}, d);
    expect(res.body.balanceMicros).toBe(CREDIT1); // not 2x — same creditId
  });

  it('accumulates balance across different purchases from the same account', async () => {
    const d = deps();
    await post('/v1/entitlement/verify', { platform: 'apple', receipt: 'jws-1' }, {}, d);
    const res = await post('/v1/entitlement/verify', { platform: 'apple', receipt: 'jws-2' }, {},
      deps({ store: d.store, verifyApple: async () => ({ ...appleResult, creditId: 'txn-2' }) }));
    expect(res.body.balanceMicros).toBe(CREDIT1 * 2);
  });

  it('always issues a token, even once the balance runs out', async () => {
    const d = deps();
    const verified = await post('/v1/entitlement/verify', { platform: 'apple', receipt: 'jws' }, {}, d);
    const sub = verifyToken(verified.body.token, SECRET).sub;
    adjustBalance(sub, -1_000_000, d.store);
    const refreshed = await post('/v1/entitlement/refresh', { token: verified.body.token }, {}, d);
    expect(refreshed.body.active).toBe(false);
    expect(refreshed.body.token).not.toBe('');
  });

  it('rejects an unknown platform', async () => {
    const res = await post('/v1/entitlement/verify', { platform: 'nintendo', receipt: 'x' });
    expect(res.status).toBe(400);
  });

  it('requires both platform and receipt', async () => {
    expect((await post('/v1/entitlement/verify', { platform: 'apple' })).status).toBe(400);
  });

  it('reports an unreachable store as 503, not as a failed purchase', async () => {
    const res = await post('/v1/entitlement/verify', { platform: 'apple', receipt: 'jws' }, {},
      deps({ verifyApple: async () => { throw new VerificationError('App Store Server API 500', 'upstream_unavailable'); } }));
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('upstream_unavailable');
  });

  it('calls Google consume after crediting a Google purchase', async () => {
    let consumed = false;
    const d = deps({ consumeGoogle: async () => { consumed = true; } });
    await post('/v1/entitlement/verify',
      { platform: 'google', receipt: { purchaseToken: 'pt', productId: 'intention_coach_credit_1' } }, {}, d);
    expect(consumed).toBe(true);
  });
});

describe('POST /v1/entitlement/refresh', () => {
  it('reports live balance without re-crediting', async () => {
    const d = deps();
    const verified = await post('/v1/entitlement/verify', { platform: 'apple', receipt: 'jws' }, {}, d);
    const refreshed = await post('/v1/entitlement/refresh', { token: verified.body.token }, {}, d);
    expect(refreshed.body.balanceMicros).toBe(CREDIT1);
  });

  it('reflects a balance changed by an intervening /v1/chat call', async () => {
    const d = deps();
    const verified = await post('/v1/entitlement/verify', { platform: 'apple', receipt: 'jws' }, {}, d);
    await post('/v1/chat', { messages: [{ role: 'user', content: 'hi' }] },
      { authorization: `Bearer ${verified.body.token}` }, d);
    const refreshed = await post('/v1/entitlement/refresh', { token: verified.body.token }, {}, d);
    expect(refreshed.body.balanceMicros).toBeLessThan(CREDIT1);
  });

  it('rejects a forged token', async () => {
    const res = await post('/v1/entitlement/refresh', { token: 'v1.aaa.bbb' });
    expect(res.status).toBe(401);
  });
});

describe('browser access codes', () => {
  it('mints a single-use code and swaps it for a token', async () => {
    const d = deps();
    const verified = await post('/v1/entitlement/verify', { platform: 'apple', receipt: 'jws' }, {}, d);
    const issued = await post('/v1/entitlement/code', null,
      { authorization: `Bearer ${verified.body.token}` }, d);
    expect(issued.status).toBe(200);
    expect(issued.body.code).toMatch(/^INT-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const redeemed = await post('/v1/entitlement/redeem', { code: issued.body.code }, {}, d);
    expect(redeemed.status).toBe(200);
    expect(redeemed.body.balanceMicros).toBe(CREDIT1);
    expect(verifyToken(redeemed.body.token, SECRET).sub).toBe(verifyToken(verified.body.token, SECRET).sub);

    // Single use: the second attempt finds nothing.
    const again = await post('/v1/entitlement/redeem', { code: issued.body.code }, {}, d);
    expect(again.status).toBe(404);
  });

  it('will not mint a code without a valid entitlement token', async () => {
    expect((await post('/v1/entitlement/code', null, {})).status).toBe(401);
  });

  it('rejects an unknown code', async () => {
    expect((await post('/v1/entitlement/redeem', { code: 'INT-ZZZZ-ZZZZ' })).status).toBe(404);
  });
});

describe('POST /v1/chat', () => {
  let token, store, sub;
  beforeEach(() => {
    store = new MemoryStore();
    sub = subjectFor('apple', 'acct-chat-1');
    adjustBalance(sub, 1_000_000, store);
    token = signToken({ sub, platform: 'apple', productId: appleResult.productId }, SECRET, 60_000);
  });

  const auth = () => ({ authorization: `Bearer ${token}` });

  it('proxies a conversation and returns the normalized shape with an updated balance', async () => {
    const res = await post('/v1/chat', {
      system: 'be kind',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'grant_access', description: 'd', schema: { type: 'object' } }]
    }, auth(), deps({
      store,
      callCoachLLM: async () => ({
        text: 'hello',
        toolCalls: [{ id: '1', name: 'grant_access', input: { minutes: 5 } }],
        usage: { inputTokens: 1000, outputTokens: 1000 }
      })
    }));
    expect(res.status).toBe(200);
    expect(res.body.text).toBe('hello');
    expect(res.body.toolCalls[0].name).toBe('grant_access');
    expect(res.body.balanceMicros).toBeLessThan(1_000_000);
    expect(res.body.balanceGbp).toBeLessThan(1);
  });

  it('refuses without a token', async () => {
    const res = await post('/v1/chat', { messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('entitlement_invalid');
  });

  it('refuses an expired token with entitlement_expired', async () => {
    const stale = signToken({ sub: 'x', exp: Date.now() - 1 }, SECRET, 0);
    const res = await post('/v1/chat', { messages: [{ role: 'user', content: 'hi' }] },
      { authorization: `Bearer ${stale}` });
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('entitlement_expired');
  });

  it('rejects malformed messages before checking balance', async () => {
    const d = deps({ store, callCoachLLM: async () => { throw new Error('should not be called'); } });
    expect((await post('/v1/chat', { messages: [] }, auth(), d)).status).toBe(400);
    expect((await post('/v1/chat', { messages: [{ role: 'system', content: 'x' }] }, auth(), d)).status).toBe(400);
    expect((await post('/v1/chat', { messages: [{ role: 'user', content: 'x'.repeat(9000) }] }, auth(), d)).status).toBe(400);
  });

  it('returns 402 balance_exhausted without calling the LLM when balance is zero', async () => {
    const emptyStore = new MemoryStore();
    const emptySub = subjectFor('apple', 'acct-empty');
    const emptyToken = signToken({ sub: emptySub, platform: 'apple', productId: appleResult.productId }, SECRET, 60_000);
    const d = deps({ store: emptyStore, callCoachLLM: async () => { throw new Error('should not be called'); } });
    const res = await post('/v1/chat', { messages: [{ role: 'user', content: 'hi' }] },
      { authorization: `Bearer ${emptyToken}` }, d);
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('balance_exhausted');
  });

  it('deducts an amount computed from actual token usage, not a flat rate', async () => {
    const shortRes = await post('/v1/chat', { messages: [{ role: 'user', content: 'hi' }] }, auth(),
      deps({ store, callCoachLLM: async () => ({ text: 'ok', toolCalls: [], usage: { inputTokens: 10, outputTokens: 10 } }) }));
    const shortSpend = 1_000_000 - shortRes.body.balanceMicros;

    const store2 = new MemoryStore();
    adjustBalance(sub, 1_000_000, store2);
    const longRes = await post('/v1/chat', { messages: [{ role: 'user', content: 'hi' }] }, auth(),
      deps({ store: store2, callCoachLLM: async () => ({ text: 'ok', toolCalls: [], usage: { inputTokens: 100_000, outputTokens: 100_000 } }) }));
    const longSpend = 1_000_000 - longRes.body.balanceMicros;

    expect(longSpend).toBeGreaterThan(shortSpend);
  });

  it('can push the balance negative on the message that exhausts it, then blocks the next one', async () => {
    const tinyStore = new MemoryStore();
    const tinySub = subjectFor('apple', 'acct-tiny');
    adjustBalance(tinySub, 1, tinyStore); // smaller than any real message cost
    const tinyToken = signToken({ sub: tinySub, platform: 'apple', productId: appleResult.productId }, SECRET, 60_000);
    const d = deps({ store: tinyStore });

    const first = await post('/v1/chat', { messages: [{ role: 'user', content: 'hi' }] },
      { authorization: `Bearer ${tinyToken}` }, d);
    expect(first.status).toBe(200);
    expect(first.body.balanceMicros).toBeLessThan(0);

    const second = await post('/v1/chat', { messages: [{ role: 'user', content: 'hi' }] },
      { authorization: `Bearer ${tinyToken}` }, d);
    expect(second.status).toBe(402);
  });
});

describe('balance ledger', () => {
  it('adjustBalance persists and accumulates', () => {
    const backing = new MemoryStore();
    adjustBalance('sub', 500, backing);
    adjustBalance('sub', 250, backing);
    expect(getBalanceMicros('sub', backing)).toBe(750);
  });

  it('never expires', () => {
    const backing = new MemoryStore();
    adjustBalance('sub', 100, backing);
    expect(backing.map.get('balance:sub').expiresAt).toBe(0);
  });

  it('the idempotency guard blocks a second credit for the same purchase id', () => {
    const backing = new MemoryStore();
    expect(alreadyCredited('apple', 'txn-x', backing)).toBe(false);
    markCredited('apple', 'txn-x', backing);
    expect(alreadyCredited('apple', 'txn-x', backing)).toBe(true);
  });
});

describe('Apple transaction info (consumable verification)', () => {
  const basePayload = () => ({
    bundleId: 'uk.co.maybeitssoftware.intention',
    productId: 'uk.co.maybeitssoftware.intention.coach.credit1',
    transactionId: 'txn-100',
    appAccountToken: 'acct-100'
  });

  it('verifies a consumable purchase and returns what is needed to credit it', async () => {
    const result = await verifyAppleReceipt(fakeJWS(basePayload()));
    expect(result).toEqual({
      productId: 'uk.co.maybeitssoftware.intention.coach.credit1',
      creditId: 'txn-100',
      appAccountToken: 'acct-100'
    });
  });

  it('rejects an unknown product', async () => {
    await expect(verifyAppleReceipt(fakeJWS({ ...basePayload(), productId: 'not-a-real-product' })))
      .rejects.toThrow(/unknown product/);
  });

  it('rejects a receipt with no transaction id', async () => {
    const payload = basePayload();
    delete payload.transactionId;
    await expect(verifyAppleReceipt(fakeJWS(payload))).rejects.toThrow(/transaction id/);
  });

  it('rejects a refunded purchase', async () => {
    await expect(verifyAppleReceipt(fakeJWS({ ...basePayload(), revocationDate: Date.now() })))
      .rejects.toThrow(/refunded/);
  });

  it('rejects a purchase with no linked account token', async () => {
    const payload = basePayload();
    delete payload.appAccountToken;
    await expect(verifyAppleReceipt(fakeJWS(payload))).rejects.toThrow(/account token/);
  });

  // Sandbox transactions chain to the same pinned Apple roots, so a free
  // sandbox account could mint unlimited signature-valid receipts. The
  // server is configured for production here, so sandbox must not credit.
  it('rejects a sandbox receipt on a production deployment', async () => {
    await expect(verifyAppleReceipt(fakeJWS({ ...basePayload(), environment: 'Sandbox' })))
      .rejects.toThrow(/environment/i);
  });

  it('accepts a production receipt with the environment stamped', async () => {
    const result = await verifyAppleReceipt(fakeJWS({ ...basePayload(), environment: 'Production' }));
    expect(result.creditId).toBe('txn-100');
  });
});

describe('Google product purchase verification', () => {
  it('verifies a consumable purchase and returns what is needed to credit it', async () => {
    const result = await verifyGooglePurchase({ purchaseToken: 'pt-100', productId: 'intention_coach_credit_1' });
    expect(result.productId).toBe('intention_coach_credit_1');
    expect(result.purchaseToken).toBe('pt-100');
    expect(result.obfuscatedExternalAccountId).toBeTruthy();
  });

  it('rejects an unknown product', async () => {
    await expect(verifyGooglePurchase({ purchaseToken: 'pt-100', productId: 'not-a-real-product' }))
      .rejects.toThrow(/unknown product/);
  });

  it('rejects a missing purchase token', async () => {
    await expect(verifyGooglePurchase({ productId: 'intention_coach_credit_1' }))
      .rejects.toThrow(/purchase token/);
  });

  // The Play record's purchaseType is only present for licence-tester, promo
  // and rewarded purchases — none of which moved real money.
  it('rejects test and promo purchases from the Play record', async () => {
    const { assertCreditablePlayPurchase } = await import('../server/src/google.js');
    const base = { purchaseState: 0, obfuscatedExternalAccountId: 'acct' };
    expect(() => assertCreditablePlayPurchase(base)).not.toThrow();
    expect(() => assertCreditablePlayPurchase({ ...base, purchaseType: 0 })).toThrow(/test and promo/i);
    expect(() => assertCreditablePlayPurchase({ ...base, purchaseType: 1 })).toThrow(/test and promo/i);
    expect(() => assertCreditablePlayPurchase({ ...base, purchaseState: 1 })).toThrow(/cancelled/i);
  });
});

describe('Apple JWS verification', () => {
  // A self-signed chain must not pass: the root fingerprint is pinned to
  // Apple's, so anyone can mint a well-formed JWS but not a trusted one.
  it('rejects a chain that does not end at an Apple root', () => {
    const jws = makeSelfSignedJWS({ productId: 'x', transactionId: '1' });
    expect(() => verifyAppleJWS(jws)).toThrow(/not signed by Apple/);
  });

  it('rejects a receipt with no certificate chain', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'ES256' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ productId: 'x' })).toString('base64url');
    expect(() => verifyAppleJWS(`${header}.${payload}.sig`)).toThrow(/certificate chain/);
  });

  it('rejects anything that is not a three-part JWS', () => {
    expect(() => decodeJWS('not-a-jws')).toThrow(/JWS/);
    expect(() => decodeJWS(null)).toThrow(/JWS/);
  });
});

describe('Refund webhooks & clawback', () => {
  it('processes an Apple REFUND notification and claws back credit', async () => {
    const d = deps();
    const verified = await post('/v1/entitlement/verify', { platform: 'apple', receipt: 'jws' }, {}, d);
    expect(verified.body.balanceMicros).toBe(CREDIT1);

    const signedTransactionInfo = fakeJWS({
      transactionId: 'txn-1',
      appAccountToken: 'acct-apple-1',
      productId: 'uk.co.maybeitssoftware.intention.coach.credit1'
    });
    const signedPayload = fakeJWS({
      notificationType: 'REFUND',
      data: { signedTransactionInfo }
    });

    const res = await post('/v1/webhooks/apple', { signedPayload }, {}, d);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.refund.deductedMicros).toBe(CREDIT1);

    const sub = subjectFor('apple', 'acct-apple-1');
    expect(getBalanceMicros(sub, d.store)).toBe(0);

    const repeat = await post('/v1/webhooks/apple', { signedPayload }, {}, d);
    expect(repeat.body.refund.alreadyRefunded).toBe(true);
  });

  it('handles non-refund Apple notifications gracefully', async () => {
    const d = deps();
    const signedPayload = fakeJWS({ notificationType: 'TEST' });
    const res = await post('/v1/webhooks/apple', { signedPayload }, {}, d);
    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(false);
  });

  it('rejects Apple webhook missing signedPayload', async () => {
    const res = await post('/v1/webhooks/apple', {}, {}, deps());
    expect(res.status).toBe(400);
  });

  // Any Apple-signed transaction passes the JWS walk — including other
  // developers' — so a replayed foreign transaction must not trigger a
  // clawback here.
  it('refuses an Apple notification for a different app', async () => {
    const d = deps();
    await post('/v1/entitlement/verify', { platform: 'apple', receipt: 'jws' }, {}, d);

    const signedPayload = fakeJWS({
      notificationType: 'REFUND',
      data: {
        signedTransactionInfo: fakeJWS({
          bundleId: 'com.someone.else',
          transactionId: 'txn-1',
          appAccountToken: 'acct-apple-1',
          productId: 'uk.co.maybeitssoftware.intention.coach.credit1'
        })
      }
    });
    const res = await post('/v1/webhooks/apple', { signedPayload }, {}, d);
    expect(res.status).toBe(401);
    expect(getBalanceMicros(subjectFor('apple', 'acct-apple-1'), d.store)).toBe(CREDIT1);
  });

  it('acknowledges but ignores a sandbox Apple refund on a production deployment', async () => {
    const d = deps();
    await post('/v1/entitlement/verify', { platform: 'apple', receipt: 'jws' }, {}, d);

    const signedPayload = fakeJWS({
      notificationType: 'REFUND',
      data: {
        signedTransactionInfo: fakeJWS({
          bundleId: 'uk.co.maybeitssoftware.intention',
          environment: 'Sandbox',
          transactionId: 'txn-1',
          appAccountToken: 'acct-apple-1',
          productId: 'uk.co.maybeitssoftware.intention.coach.credit1'
        })
      }
    });
    const res = await post('/v1/webhooks/apple', { signedPayload }, {}, d);
    expect(res.status).toBe(200); // 2xx so Apple does not retry genuine sandbox traffic
    expect(res.body.processed).toBe(false);
    expect(getBalanceMicros(subjectFor('apple', 'acct-apple-1'), d.store)).toBe(CREDIT1);
  });

  it('processes a Google RTDN refund notification and claws back credit', async () => {
    const d = deps();
    const verified = await post('/v1/entitlement/verify',
      { platform: 'google', receipt: { purchaseToken: 'ptoken-1', productId: 'intention_coach_credit_1' } }, {}, d);
    expect(verified.body.balanceMicros).toBe(CREDIT1);

    const pubsubData = Buffer.from(JSON.stringify({
      oneTimeProductNotification: {
        notificationType: 2,
        purchaseToken: 'ptoken-1',
        sku: 'intention_coach_credit_1'
      }
    })).toString('base64');

    const res = await post('/v1/webhooks/google', { message: { data: pubsubData } }, webhookAuth, d);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.refund.deductedMicros).toBe(CREDIT1);

    const sub = subjectFor('google', 'acct-google-1');
    expect(getBalanceMicros(sub, d.store)).toBe(0);
  });

  it('handles Google Pub/Sub test notifications', async () => {
    const d = deps();
    const res = await post('/v1/webhooks/google', { testNotification: { version: '1.0' } }, webhookAuth, d);
    expect(res.status).toBe(200);
    expect(res.body.test).toBe(true);
  });

  it('rejects Google webhook missing message data', async () => {
    const res = await post('/v1/webhooks/google', {}, webhookAuth, deps());
    expect(res.status).toBe(400);
  });

  it('refundTopUp prevents re-crediting a transaction that really was credited', async () => {
    const store = new MemoryStore();
    const sub = subjectFor('apple', 'acct-refund-test');
    adjustBalance(sub, CREDIT1, store);
    markCredited('apple', 'txn-refunded', {
      subject: sub, productId: 'uk.co.maybeitssoftware.intention.coach.credit1',
      creditMicros: CREDIT1, refunded: false, creditId: 'txn-refunded'
    }, store);

    const result = refundTopUp('apple', 'txn-refunded', { subject: sub }, store);
    expect(result.refunded).toBe(true);
    expect(result.deductedMicros).toBe(CREDIT1);
    expect(alreadyCredited('apple', 'txn-refunded', store)).toBe(true);
    expect(getCreditRecord('apple', 'txn-refunded', store).refunded).toBe(true);
  });

  it('a refund for a never-credited purchase writes nothing, so a later verify still credits', async () => {
    const d = deps();
    // Refund arrives first (out of order, or hostile) — before any credit.
    const result = refundTopUp('apple', 'txn-1', { subject: subjectFor('apple', 'acct-apple-1') }, d.store);
    expect(result.refunded).toBe(false);
    expect(result.noCreditRecord).toBe(true);
    expect(alreadyCredited('apple', 'txn-1', d.store)).toBe(false);

    // The legitimate purchase then verifies and must still credit in full.
    const verified = await post('/v1/entitlement/verify', { platform: 'apple', receipt: 'jws' }, {}, d);
    expect(verified.status).toBe(200);
    expect(verified.body.balanceMicros).toBe(CREDIT1);
  });
});

// Builds a structurally valid ES256 JWS with a self-signed x5c chain — enough
// to reach the fingerprint check, which is what we want to see fail.
function makeSelfSignedJWS(payload) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const cert = selfSignedCertificate(privateKey, publicKey);
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', x5c: [cert, cert] })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${body}`), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363'
  }).toString('base64url');
  return `${header}.${body}.${signature}`;
}

// Minimal DER certificate builder — node has no public API for issuing one.
function selfSignedCertificate(privateKey, publicKey) {
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const tbs = der(0x30, Buffer.concat([
    der(0xa0, der(0x02, Buffer.from([0x02]))),                       // version v3
    der(0x02, Buffer.from([0x01])),                                  // serial
    algorithmIdentifier(),
    name(), validity(), name(),
    spki
  ]));
  const signature = crypto.sign('sha256', tbs, privateKey);
  const certificate = der(0x30, Buffer.concat([
    tbs,
    algorithmIdentifier(),
    der(0x03, Buffer.concat([Buffer.from([0x00]), signature]))
  ]));
  return certificate.toString('base64');
}

function der(tag, content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
  if (body.length < 0x80) return Buffer.concat([Buffer.from([tag, body.length]), body]);
  const lengthBytes = [];
  let remaining = body.length;
  while (remaining > 0) {
    lengthBytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return Buffer.concat([Buffer.from([tag, 0x80 | lengthBytes.length, ...lengthBytes]), body]);
}

function algorithmIdentifier() {
  // ecdsa-with-SHA256: 1.2.840.10045.4.3.2
  return der(0x30, der(0x06, Buffer.from([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02])));
}

function name() {
  // CN=test
  const cn = der(0x30, Buffer.concat([
    der(0x06, Buffer.from([0x55, 0x04, 0x03])),
    der(0x0c, Buffer.from('test'))
  ]));
  return der(0x30, der(0x31, cn));
}

function validity() {
  const fmt = (date) => date.toISOString().replace(/[-:]/g, '').slice(2, 14) + 'Z';
  return der(0x30, Buffer.concat([
    der(0x17, Buffer.from(fmt(new Date(Date.now() - 86400000)))),
    der(0x17, Buffer.from(fmt(new Date(Date.now() + 86400000))))
  ]));
}

// The balance used to be read, then awaited across the LLM call, then
// deducted. Every request arriving during that await saw the same untouched
// balance and passed, so one topped-up token admitted unlimited concurrent
// calls on the operator's provider key. A synchronous check-and-reserve closes
// it: Node cannot interleave requests where there is no await.
describe('credit is reserved, not just checked', () => {
  const tokenFor = (sub) => signToken({ sub, platform: 'apple', productId: appleResult.productId }, SECRET, 60_000);

  // An LLM call that parks until released, so several requests are genuinely
  // in flight at once -- the only way to exercise the race.
  function deferredLLM() {
    let release;
    const gate = new Promise(r => { release = r; });
    const started = [];
    return {
      release: () => release(),
      started,
      call: async () => {
        started.push(1);
        await gate;
        return { text: 'ok', toolCalls: [], usage: { inputTokens: 1000, outputTokens: 1000 } };
      }
    };
  }

  it('does not let concurrent calls spend one balance many times over', async () => {
    const store = new MemoryStore();
    const sub = subjectFor('apple', 'acct-race');
    adjustBalance(sub, 1, store); // enough to admit one message, nowhere near five
    const llm = deferredLLM();
    const d = deps({ store, callCoachLLM: llm.call });

    const calls = Array.from({ length: 5 }, () =>
      post('/v1/chat', { messages: [{ role: 'user', content: 'hi' }] },
        { authorization: `Bearer ${tokenFor(sub)}` }, d));
    llm.release();
    const results = await Promise.all(calls);

    // Before the fix all five reached the provider on a 1-micro balance.
    expect(llm.started.length).toBeLessThanOrEqual(2);
    expect(results.filter(r => r.status === 200).length).toBeLessThanOrEqual(2);
    expect(results.some(r => r.status === 429 || r.status === 402)).toBe(true);
  });

  it('refuses a third simultaneous call from one subject', async () => {
    const store = new MemoryStore();
    const sub = subjectFor('apple', 'acct-inflight');
    adjustBalance(sub, 5_000_000, store);
    const llm = deferredLLM();
    const d = deps({ store, callCoachLLM: llm.call });

    const first = post('/v1/chat', { messages: [{ role: 'user', content: 'a' }] },
      { authorization: `Bearer ${tokenFor(sub)}` }, d);
    const second = post('/v1/chat', { messages: [{ role: 'user', content: 'b' }] },
      { authorization: `Bearer ${tokenFor(sub)}` }, d);
    const third = await post('/v1/chat', { messages: [{ role: 'user', content: 'c' }] },
      { authorization: `Bearer ${tokenFor(sub)}` }, d);

    expect(third.status).toBe(429);
    expect(third.body.code).toBe('too_many_inflight');

    llm.release();
    await Promise.all([first, second]);
  });

  it('releases the hold when the provider call fails', async () => {
    const store = new MemoryStore();
    const sub = subjectFor('apple', 'acct-fail');
    adjustBalance(sub, 5_000_000, store);
    let calls = 0;
    const d = deps({
      store,
      callCoachLLM: async () => {
        calls += 1;
        if (calls === 1) throw new UpstreamError('provider down', 502);
        return { text: 'ok', toolCalls: [], usage: { inputTokens: 10, outputTokens: 10 } };
      }
    });

    const failed = await post('/v1/chat', { messages: [{ role: 'user', content: 'a' }] },
      { authorization: `Bearer ${tokenFor(sub)}` }, d);
    expect(failed.status).toBe(502);

    // A hold leaked on the error path would starve every later request.
    const after = await post('/v1/chat', { messages: [{ role: 'user', content: 'b' }] },
      { authorization: `Bearer ${tokenFor(sub)}` }, d);
    expect(after.status).toBe(200);
  });
});

// The refund webhook deducts credit, so an unset secret used to mean the whole
// auth block was skipped: anyone could POST a voidedPurchaseNotification and
// claw back another account's balance. It now fails closed.
describe('the Google refund webhook authenticates', () => {
  const pubsub = (obj) => ({ message: { data: Buffer.from(JSON.stringify(obj)).toString('base64') } });
  const notification = pubsub({
    voidedPurchaseNotification: { purchaseToken: 'ptoken-1', orderId: 'order-1' }
  });

  it('rejects a request presenting no secret', async () => {
    const res = await post('/v1/webhooks/google', notification, {}, deps());
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('unauthorized');
  });

  it('rejects a wrong secret', async () => {
    const res = await post('/v1/webhooks/google', notification,
      { authorization: 'Bearer not-the-secret' }, deps());
    expect(res.status).toBe(401);
  });

  it('rejects a secret of a different length without throwing', async () => {
    // timingSafeEqual throws on a length mismatch, which would surface as a
    // 500 rather than a clean 401.
    const res = await post('/v1/webhooks/google', notification,
      { authorization: 'Bearer x' }, deps());
    expect(res.status).toBe(401);
  });

  it('accepts the secret as a query parameter, which is what Pub/Sub can send', async () => {
    // Push subscriptions cannot set request headers, so ?token= is the only
    // mechanism that works for real RTDN traffic. index.js used to discard the
    // query string entirely, so this could never have worked.
    const res = await handleRequest({
      method: 'POST',
      path: '/v1/webhooks/google',
      query: { token: WEBHOOK_SECRET },
      headers: {},
      body: notification
    }, deps());
    expect(res.status).toBe(200);
  });

  it('no longer accepts the secret in the request body', async () => {
    // That path never fired for real Pub/Sub traffic and put the secret
    // somewhere body logging would capture it.
    const res = await post('/v1/webhooks/google',
      { ...notification, token: WEBHOOK_SECRET }, {}, deps());
    expect(res.status).toBe(401);
  });
});

// The store used to be memory-only, so a redeploy wiped paid balances and —
// worse — forgot which receipts were already credited, letting the same Apple
// JWS be re-POSTed for fresh credit after every restart.
describe('FileStore durability', () => {
  const stateFile = () => join(mkdtempSync(join(tmpdir(), 'intention-store-')), 'state.json');

  it('does not re-credit an already-spent receipt after a restart', async () => {
    const file = stateFile();
    const first = await post('/v1/entitlement/verify',
      { platform: 'apple', receipt: 'jws' }, {}, deps({ store: new FileStore(file) }));
    expect(first.status).toBe(200);
    expect(first.body.balanceMicros).toBe(CREDIT1);

    // A second store over the same file is a process restart.
    const again = await post('/v1/entitlement/verify',
      { platform: 'apple', receipt: 'jws' }, {}, deps({ store: new FileStore(file) }));
    expect(again.status).toBe(200);
    expect(again.body.balanceMicros).toBe(CREDIT1); // unchanged, not doubled
  });

  it('keeps balances, including spend, across a restart', () => {
    const file = stateFile();
    const before = new FileStore(file);
    adjustBalance('sub-1', 500_000, before);
    adjustBalance('sub-1', -100_000, before);

    const after = new FileStore(file);
    expect(getBalanceMicros('sub-1', after)).toBe(400_000);
  });

  it('drops expired entries on reload instead of resurrecting them', () => {
    const file = stateFile();
    const before = new FileStore(file);
    before.set('code:INT-EXPIRED', { sub: 'x' }, -1);
    before.set('keep', 'me', null);

    const after = new FileStore(file);
    expect(after.get('code:INT-EXPIRED')).toBe(null);
    expect(after.get('keep')).toBe('me');
  });

  it('refuses to boot from a corrupt state file rather than starting empty', () => {
    const file = stateFile();
    writeFileSync(file, '{definitely not json');
    expect(() => new FileStore(file)).toThrow();
  });
});

// The backend had no rate limiting at all: nothing bounded chat volume per
// token, and the short human-typeable linking codes were open to brute force.
describe('rate limiting', () => {
  const chatBody = { messages: [{ role: 'user', content: 'hi' }] };
  const tokenFor = (sub) => signToken({ sub, platform: 'apple', productId: 'p' }, SECRET, 60_000);
  const auth = (sub) => ({ authorization: `Bearer ${tokenFor(sub)}` });

  it('throttles /v1/chat per subject, not per connection', async () => {
    const d = deps();
    adjustBalance('sub-chat', 10_000_000, d.store);
    let last;
    for (let i = 0; i < 31; i++) {
      last = await post('/v1/chat', chatBody, auth('sub-chat'), d);
    }
    expect(last.status).toBe(429);
    expect(last.body.code).toBe('rate_limited');

    // A different subject through the same limiter is unaffected.
    adjustBalance('sub-other', 10_000_000, d.store);
    const other = await post('/v1/chat', chatBody, auth('sub-other'), d);
    expect(other.status).toBe(200);
  });

  it('throttles unauthenticated verify per IP before verification runs', async () => {
    let verifierCalls = 0;
    const d = deps({ verifyApple: async () => { verifierCalls++; return appleResult; } });
    let last;
    for (let i = 0; i < 31; i++) {
      last = await handleRequest({
        method: 'POST', path: '/v1/entitlement/verify', headers: {},
        body: { platform: 'apple', receipt: 'jws' }, ip: '203.0.113.9'
      }, d);
    }
    expect(last.status).toBe(429);
    expect(verifierCalls).toBe(30); // the 31st never reached the verifier

    const otherIp = await handleRequest({
      method: 'POST', path: '/v1/entitlement/verify', headers: {},
      body: { platform: 'apple', receipt: 'jws' }, ip: '203.0.113.10'
    }, d);
    expect(otherIp.status).toBe(200);
  });

  it('locks out an IP that keeps guessing redeem codes', async () => {
    const d = deps();
    for (let i = 0; i < 10; i++) {
      const res = await handleRequest({
        method: 'POST', path: '/v1/entitlement/redeem', headers: {},
        body: { code: `INT-WRONG-${i}` }, ip: '198.51.100.7'
      }, d);
      expect(res.status).toBe(404);
    }
    // Even a CORRECT code is refused once the miss budget is spent.
    const { generateAccessCode } = await import('../server/src/store.js');
    const { code } = generateAccessCode({ sub: 's', platform: 'apple', productId: 'p' }, { backing: d.store });
    const blocked = await handleRequest({
      method: 'POST', path: '/v1/entitlement/redeem', headers: {},
      body: { code }, ip: '198.51.100.7'
    }, d);
    expect(blocked.status).toBe(429);

    // A fresh IP with the real code still gets through.
    const ok = await handleRequest({
      method: 'POST', path: '/v1/entitlement/redeem', headers: {},
      body: { code }, ip: '198.51.100.8'
    }, d);
    expect(ok.status).toBe(200);
  });

  it('successful redemptions do not consume the miss budget', async () => {
    const d = deps();
    const { generateAccessCode } = await import('../server/src/store.js');
    for (let i = 0; i < 12; i++) {
      const { code } = generateAccessCode({ sub: 's', platform: 'apple', productId: 'p' }, { backing: d.store });
      const res = await handleRequest({
        method: 'POST', path: '/v1/entitlement/redeem', headers: {},
        body: { code }, ip: '198.51.100.9'
      }, d);
      expect(res.status).toBe(200);
    }
  });
});

// Per-field caps alone multiply into a huge bill (60 messages x 8k chars ≈
// 120k input tokens on one call), and tools/system used to reach the provider
// with no validation at all.
describe('LLM input cost caps', () => {
  const authed = (d) => {
    adjustBalance('sub-caps', 10_000_000, d.store);
    return { authorization: `Bearer ${signToken({ sub: 'sub-caps' }, SECRET, 60_000)}` };
  };
  const msg = (content) => ({ role: 'user', content });

  it('rejects a non-string system instead of coercing it away', async () => {
    const d = deps();
    const res = await post('/v1/chat', { messages: [msg('hi')], system: { sneaky: true } }, authed(d), d);
    expect(res.status).toBe(400);
  });

  it('rejects when the aggregate is huge even though every field is within its own cap', async () => {
    const d = deps();
    // 20 messages of 8000 chars each: individually legal, 160k chars total.
    const messages = Array.from({ length: 20 }, () => msg('x'.repeat(8000)));
    const res = await post('/v1/chat', { messages }, authed(d), d);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('bad_request');
  });

  it('still accepts a realistic full-size gate request', async () => {
    const d = deps();
    const res = await post('/v1/chat', {
      messages: Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(500) })),
      system: 'y'.repeat(13_000),
      tools: [{
        name: 'grant_access',
        description: 'd'.repeat(400),
        schema: { type: 'object', properties: { minutes: { type: 'number' } }, required: ['minutes'] }
      }]
    }, authed(d), d);
    expect(res.status).toBe(200);
  });

  it('rejects malformed tool names and oversized schemas', async () => {
    const d = deps();
    const bad = await post('/v1/chat', {
      messages: [msg('hi')],
      tools: [{ name: 'evil tool; drop', schema: { type: 'object' } }]
    }, authed(d), d);
    expect(bad.status).toBe(400);

    const big = await post('/v1/chat', {
      messages: [msg('hi')],
      tools: [{ name: 'ok_tool', schema: { type: 'object', description: 'z'.repeat(5000) } }]
    }, authed(d), d);
    expect(big.status).toBe(400);

    let nested = { type: 'object' };
    for (let i = 0; i < 12; i++) nested = { type: 'object', properties: { deep: nested } };
    const deep = await post('/v1/chat', {
      messages: [msg('hi')], tools: [{ name: 'ok_tool', schema: nested }]
    }, authed(d), d);
    expect(deep.status).toBe(400);
  });

  it('strips prototype-polluting keys from schemas before the provider sees them', async () => {
    let seenTools;
    const d = deps({
      callCoachLLM: async ({ tools }) => {
        seenTools = tools;
        return { text: 'ok', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
      }
    });
    const schema = JSON.parse('{"type":"object","properties":{"a":{"type":"string"}},"__proto__":{"polluted":true},"constructor":{"x":1}}');
    const res = await post('/v1/chat', {
      messages: [msg('hi')], tools: [{ name: 'ok_tool', schema }]
    }, authed(d), d);
    expect(res.status).toBe(200);
    const serialized = JSON.stringify(seenTools[0].schema);
    expect(serialized).not.toContain('__proto__');
    expect(serialized).not.toContain('constructor');
    expect(seenTools[0].schema.properties.a.type).toBe('string');
  });
});
