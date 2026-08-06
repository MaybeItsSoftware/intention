import crypto from 'node:crypto';

// Entitlement tokens: a signed statement that a given store subscription was
// verified and is good until `exp`. Clients send one as a bearer token on every
// coaching call, so /v1/chat never has to re-contact Apple or Google.
//
// Format: v1.<base64url(payload)>.<base64url(hmac-sha256)>
//
// Deliberately not a JWT library: the payload is ours, the algorithm is fixed
// (no `alg` field to confuse), and there is exactly one key.

const PREFIX = 'v1';

function b64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function hmac(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest();
}

export function signToken(payload, secret, ttlMs) {
  if (!secret) throw new Error('token secret not configured');
  const body = {
    ...payload,
    iat: Date.now(),
    exp: payload.exp || Date.now() + (ttlMs || 0)
  };
  const encoded = b64url(JSON.stringify(body));
  const signature = b64url(hmac(`${PREFIX}.${encoded}`, secret));
  return `${PREFIX}.${encoded}.${signature}`;
}

export class TokenError extends Error {
  constructor(message, code = 'entitlement_invalid') {
    super(message);
    this.code = code;
  }
}

// Constant-time string comparison, for secrets compared outside the token
// path (the webhook shared secret). Length is checked first because
// timingSafeEqual throws on a length mismatch rather than returning false —
// the same trap guarded below. Length is not itself secret here.
export function safeEqualString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function verifyToken(token, secret) {
  if (!secret) throw new TokenError('token secret not configured');
  if (typeof token !== 'string') throw new TokenError('missing token');
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) throw new TokenError('malformed token');

  const expected = hmac(`${PREFIX}.${parts[1]}`, secret);
  const actual = Buffer.from(parts[2], 'base64url');
  // Length-check first: timingSafeEqual throws on a mismatch rather than
  // returning false, which would surface as a 500 instead of a clean 401.
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new TokenError('bad signature');
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch (e) {
    throw new TokenError('malformed payload');
  }

  if (!payload.exp || Date.now() > Number(payload.exp)) {
    throw new TokenError('token expired', 'entitlement_expired');
  }
  return payload;
}

// Stable, non-reversible identifier for a purchasing account, used as the
// balance key so a raw store account token never becomes our primary key in
// logs. Keyed by the platform's stable per-account token (Apple's
// appAccountToken / Google's obfuscatedExternalAccountId), not a
// per-transaction id, so repeat top-ups by the same person accumulate into
// one balance.
export function subjectFor(platform, accountToken) {
  return crypto.createHash('sha256')
    .update(`${platform}:${accountToken}`)
    .digest('hex')
    .slice(0, 32);
}
