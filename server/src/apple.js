import crypto from 'node:crypto';
import { config } from './config.js';

// Apple receipt verification.
//
// The client sends the JWS representation of a StoreKit 2 signed transaction.
// Two independent checks run against it:
//
//   1. Signature. The JWS header carries Apple's certificate chain (x5c);
//      each link is verified against the next, and the root has to be one of
//      Apple's pinned root certificates. This alone proves Apple issued the
//      transaction and nothing has been altered.
//   2. Current status. If App Store Server API credentials are configured, the
//      subscription is re-read from Apple, which is the only way to see a
//      renewal, cancellation, or refund that happened after the receipt was
//      minted.
//
// A receipt that fails (1) is rejected. (2) is skipped with a warning when the
// credentials aren't configured — see assertBootConfig.

export class VerificationError extends Error {
  constructor(message, code = 'entitlement_invalid') {
    super(message);
    this.code = code;
  }
}

// SHA-256 fingerprints of Apple's public root certificates. Pinning the root
// is what stops a self-signed chain from passing the walk below.
const APPLE_ROOT_FINGERPRINTS = new Set([
  // Apple Root CA - G3
  'B0:B1:73:0E:CB:C7:FF:45:05:14:2C:49:F1:29:5E:6E:DA:6B:CA:ED:7E:2C:68:C5:BE:91:B5:A1:10:01:F0:24',
  // Apple Root CA (G2), still seen on older chains
  'C2:B9:B0:42:DD:57:83:0E:7D:11:7D:AC:55:AC:8A:E1:94:07:D3:8E:41:D8:8F:38:15:19:F7:59:F3:04:A5:4B'
].map(f => f.toUpperCase()));

function decodeSegment(segment) {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

export function decodeJWS(jws) {
  if (typeof jws !== 'string') throw new VerificationError('receipt is not a JWS');
  const parts = jws.split('.');
  if (parts.length !== 3) throw new VerificationError('receipt is not a JWS');
  return {
    header: decodeSegment(parts[0]),
    payload: decodeSegment(parts[1]),
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: Buffer.from(parts[2], 'base64url')
  };
}

// Walks the x5c chain leaf -> intermediate -> root, then checks the leaf's
// signature over the JWS. Throws VerificationError on any break.
export function verifyAppleJWS(jws, { rootFingerprints = APPLE_ROOT_FINGERPRINTS, now = new Date() } = {}) {
  const { header, signingInput, signature, payload } = decodeJWS(jws);
  const chain = header.x5c;
  if (!Array.isArray(chain) || chain.length < 2) {
    throw new VerificationError('receipt has no certificate chain');
  }

  const certs = chain.map(der => new crypto.X509Certificate(Buffer.from(der, 'base64')));

  for (const cert of certs) {
    if (new Date(cert.validFrom) > now || new Date(cert.validTo) < now) {
      throw new VerificationError('receipt certificate is not currently valid');
    }
  }

  for (let i = 0; i < certs.length - 1; i++) {
    if (!certs[i].verify(certs[i + 1].publicKey)) {
      throw new VerificationError('receipt certificate chain is broken');
    }
  }

  const root = certs[certs.length - 1];
  const fingerprint = (root.fingerprint256 || '').toUpperCase();
  if (!rootFingerprints.has(fingerprint)) {
    throw new VerificationError('receipt was not signed by Apple');
  }

  // StoreKit signs with ES256; Node needs the IEEE P1363 hint because JWS
  // signatures are raw r||s rather than DER.
  const ok = crypto.verify(
    'sha256',
    Buffer.from(signingInput),
    { key: certs[0].publicKey, dsaEncoding: 'ieee-p1363' },
    signature
  );
  if (!ok) throw new VerificationError('receipt signature does not match');

  return payload;
}

// ---- App Store Server API -------------------------------------------------

function appStoreBaseUrl() {
  return config.apple.environment === 'sandbox'
    ? 'https://api.storekit-sandbox.itunes.apple.com'
    : 'https://api.storekit.itunes.apple.com';
}

function appStoreJWT() {
  const { issuerId, keyId, privateKey, bundleId } = config.apple;
  const header = { alg: 'ES256', kid: keyId, typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: issuerId,
    iat: now,
    exp: now + 15 * 60,
    aud: 'appstoreconnect-v1',
    bid: bundleId
  };
  const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const signingInput = `${encode(header)}.${encode(payload)}`;
  const signature = crypto.sign(
    'sha256',
    Buffer.from(signingInput),
    { key: privateKey, dsaEncoding: 'ieee-p1363' }
  );
  return `${signingInput}.${signature.toString('base64url')}`;
}

async function fetchSubscriptionStatus(originalTransactionId) {
  const res = await fetch(
    `${appStoreBaseUrl()}/inApps/v1/subscriptions/${encodeURIComponent(originalTransactionId)}`,
    { headers: { authorization: `Bearer ${appStoreJWT()}` } }
  );
  if (res.status === 404) throw new VerificationError('Apple has no record of that subscription');
  if (!res.ok) {
    // Apple being unavailable must not read as "not subscribed".
    throw new VerificationError(`App Store Server API ${res.status}`, 'upstream_unavailable');
  }
  return res.json();
}

// Apple's states: 1 active, 2 expired, 3 in billing retry, 4 grace period,
// 5 revoked. Access is allowed while active or in grace; billing retry keeps
// access too, since Apple is still trying to charge a paying customer.
const ALLOWED_STATUSES = new Set([1, 4, 3]);

/**
 * Verifies an Apple receipt and returns the entitlement it proves.
 * @returns {{ active, productId, expiresAt, originalTransactionId }}
 */
export async function verifyAppleReceipt(jws) {
  let payload;
  if (config.allowUnverifiedReceipts) {
    payload = decodeJWS(jws).payload;
  } else {
    payload = verifyAppleJWS(jws);
  }

  if (payload.bundleId && payload.bundleId !== config.apple.bundleId) {
    throw new VerificationError('receipt is for a different app');
  }
  if (payload.productId && !config.apple.productIds.includes(payload.productId)) {
    throw new VerificationError('receipt is for an unknown product');
  }

  const originalTransactionId = String(payload.originalTransactionId || payload.transactionId || '');
  if (!originalTransactionId) throw new VerificationError('receipt has no transaction id');

  let productId = payload.productId || '';
  let expiresAt = payload.expiresDate ? Number(payload.expiresDate) : null;
  let active = !expiresAt || expiresAt > Date.now();
  if (payload.revocationDate) active = false;

  // Authoritative pass, when we have the credentials for it.
  if (config.apple.issuerId && config.apple.privateKey && config.apple.keyId) {
    const status = await fetchSubscriptionStatus(originalTransactionId);
    const entry = (status.data || [])
      .flatMap(group => group.lastTransactions || [])
      .find(t => String(t.originalTransactionId) === originalTransactionId);
    if (!entry) throw new VerificationError('Apple has no record of that subscription');

    active = ALLOWED_STATUSES.has(Number(entry.status));
    if (entry.signedTransactionInfo) {
      const info = config.allowUnverifiedReceipts
        ? decodeJWS(entry.signedTransactionInfo).payload
        : verifyAppleJWS(entry.signedTransactionInfo);
      productId = info.productId || productId;
      expiresAt = info.expiresDate ? Number(info.expiresDate) : expiresAt;
      if (info.revocationDate) active = false;
    }
  }

  return { active, productId, expiresAt, originalTransactionId };
}
