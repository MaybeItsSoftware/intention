// Backend tests: entitlement tokens, the verify/refresh/redeem endpoints, the
// quota, and the coaching proxy's input validation.
//
// The store verifications (Apple JWS, Play Developer API) are injected, so
// these run without network access or store credentials; apple.js's signature
// walk is exercised separately below with a locally generated chain.

import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';

process.env.INTENTION_TOKEN_SECRET = 'test-secret-do-not-use';
process.env.INTENTION_LLM_API_KEY = 'test-llm-key';
process.env.INTENTION_DAILY_QUOTA = '3';

const { handleRequest } = await import('../server/src/app.js');
const { signToken, verifyToken, subjectFor } = await import('../server/src/tokens.js');
const { MemoryStore, consumeQuota, generateAccessCode, redeemAccessCode } = await import('../server/src/store.js');
const { verifyAppleJWS, decodeJWS } = await import('../server/src/apple.js');

const SECRET = 'test-secret-do-not-use';
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

const appleEntitlement = {
  active: true,
  productId: 'uk.co.maybeitssoftware.intention.pro.monthly',
  expiresAt: Date.now() + MONTH_MS,
  originalTransactionId: '2000000012345678'
};

const deps = (overrides = {}) => ({
  store: new MemoryStore(),
  verifyApple: async () => appleEntitlement,
  verifyGoogle: async () => ({ ...appleEntitlement, productId: 'intention_pro_monthly' }),
  callCoachLLM: async () => ({ text: 'ok', toolCalls: [] }),
  ...overrides
});

const post = (path, body, headers = {}, d = deps()) =>
  handleRequest({ method: 'POST', path, headers, body }, d);

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
  it('mints a token for a verified Apple receipt', async () => {
    const res = await post('/v1/entitlement/verify', { platform: 'apple', receipt: 'jws' });
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(true);
    expect(res.body.productId).toBe(appleEntitlement.productId);
    expect(verifyToken(res.body.token, SECRET).platform).toBe('apple');
  });

  it('issues no token when the store says the subscription is not active', async () => {
    const res = await post('/v1/entitlement/verify', { platform: 'apple', receipt: 'jws' }, {},
      deps({ verifyApple: async () => ({ ...appleEntitlement, active: false }) }));
    expect(res.body.active).toBe(false);
    expect(res.body.token).toBe('');
  });

  // A cancelled subscription must not keep working just because the token's own
  // TTL is longer than the time left on the plan.
  it('caps the token to the subscription expiry', async () => {
    const expiresAt = Date.now() + 60_000;
    const res = await post('/v1/entitlement/verify', { platform: 'apple', receipt: 'jws' }, {},
      deps({ verifyApple: async () => ({ ...appleEntitlement, expiresAt }) }));
    const claims = verifyToken(res.body.token, SECRET);
    expect(claims.exp).toBeLessThanOrEqual(expiresAt);
  });

  it('rejects an unknown platform', async () => {
    const res = await post('/v1/entitlement/verify', { platform: 'nintendo', receipt: 'x' });
    expect(res.status).toBe(400);
  });

  it('requires both platform and receipt', async () => {
    expect((await post('/v1/entitlement/verify', { platform: 'apple' })).status).toBe(400);
  });

  it('reports an unreachable store as 503, not as "not subscribed"', async () => {
    const err = Object.assign(new Error('App Store Server API 500'), { code: 'upstream_unavailable' });
    const { VerificationError } = await import('../server/src/apple.js');
    const res = await post('/v1/entitlement/verify', { platform: 'apple', receipt: 'jws' }, {},
      deps({ verifyApple: async () => { throw new VerificationError(err.message, 'upstream_unavailable'); } }));
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('upstream_unavailable');
  });
});

describe('POST /v1/entitlement/refresh', () => {
  it('re-checks the receipt with the store', async () => {
    let called = false;
    const token = signToken({
      sub: 'abc', platform: 'apple', receipt: 'jws', productId: appleEntitlement.productId
    }, SECRET, 60_000);
    const res = await post('/v1/entitlement/refresh', { token }, {}, deps({
      verifyApple: async () => { called = true; return { ...appleEntitlement, active: false }; }
    }));
    expect(called).toBe(true);
    expect(res.body.active).toBe(false);
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
  let token;
  beforeEach(() => {
    token = signToken({ sub: subjectFor('apple', '1'), platform: 'apple' }, SECRET, 60_000);
  });

  const auth = () => ({ authorization: `Bearer ${token}` });

  it('proxies a conversation and returns the normalized shape', async () => {
    const res = await post('/v1/chat', {
      system: 'be kind',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'grant_access', description: 'd', schema: { type: 'object' } }]
    }, auth(), deps({ callCoachLLM: async () => ({ text: 'hello', toolCalls: [{ id: '1', name: 'grant_access', input: { minutes: 5 } }] }) }));
    expect(res.status).toBe(200);
    expect(res.body.text).toBe('hello');
    expect(res.body.toolCalls[0].name).toBe('grant_access');
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

  it('rejects malformed messages before spending quota', async () => {
    const d = deps({ callCoachLLM: async () => { throw new Error('should not be called'); } });
    expect((await post('/v1/chat', { messages: [] }, auth(), d)).status).toBe(400);
    expect((await post('/v1/chat', { messages: [{ role: 'system', content: 'x' }] }, auth(), d)).status).toBe(400);
    expect((await post('/v1/chat', { messages: [{ role: 'user', content: 'x'.repeat(9000) }] }, auth(), d)).status).toBe(400);
  });

  it('enforces the daily quota per subscription', async () => {
    const d = deps();
    const body = { messages: [{ role: 'user', content: 'hi' }] };
    for (let i = 0; i < 3; i++) {
      expect((await post('/v1/chat', body, auth(), d)).status).toBe(200);
    }
    const blocked = await post('/v1/chat', body, auth(), d);
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('quota_exceeded');
  });

  it('counts quota per subscription, not globally', async () => {
    const d = deps();
    const other = signToken({ sub: subjectFor('apple', '2'), platform: 'apple' }, SECRET, 60_000);
    const body = { messages: [{ role: 'user', content: 'hi' }] };
    for (let i = 0; i < 3; i++) await post('/v1/chat', body, auth(), d);
    const res = await post('/v1/chat', body, { authorization: `Bearer ${other}` }, d);
    expect(res.status).toBe(200);
  });
});

describe('quota window', () => {
  // Re-stamping the TTL on every message would turn the daily cap into a
  // rolling one that never resets.
  it('keeps the original expiry across increments', () => {
    const backing = new MemoryStore();
    consumeQuota('sub', 10, backing);
    const first = backing.map.get([...backing.map.keys()][0]).expiresAt;
    consumeQuota('sub', 10, backing);
    const second = backing.map.get([...backing.map.keys()][0]).expiresAt;
    expect(second).toBeLessThanOrEqual(first);
  });
});

describe('Apple JWS verification', () => {
  // A self-signed chain must not pass: the root fingerprint is pinned to
  // Apple's, so anyone can mint a well-formed JWS but not a trusted one.
  it('rejects a chain that does not end at an Apple root', () => {
    const jws = makeSelfSignedJWS({ productId: 'x', originalTransactionId: '1' });
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
