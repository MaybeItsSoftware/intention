import crypto from 'node:crypto';
import { config, findTopUp } from './config.js';

// Apple receipt verification for a consumable coaching-credit top-up.
//
// The client sends the JWS representation of a StoreKit 2 signed transaction.
// Two independent checks run against it:
//
//   1. Signature. The JWS header carries Apple's certificate chain (x5c);
//      each link is verified against the next, and the root has to be one of
//      Apple's pinned root certificates. This alone proves Apple issued the
//      transaction and nothing has been altered.
//   2. Current record. If App Store Server API credentials are configured,
//      the transaction is re-read from Apple via Get Transaction Info — the
//      only way to see a refund that happened after the receipt was minted.
//      There is no "status" for a consumable the way there is for a
//      subscription (no renewal/grace/billing-retry) — a transaction is
//      either on record and not revoked, or it isn't.
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

const PRODUCTION_BASE_URL = 'https://api.storekit.itunes.apple.com';
const SANDBOX_BASE_URL = 'https://api.storekit-sandbox.itunes.apple.com';

// Which App Store to ask, and in what order.
//
// Apple gives you no way to know which environment a transaction belongs to
// before asking: both environments sign the same payload shape and chain to
// the same roots. App Review always transacts in sandbox — as does TestFlight
// — so a production-only lookup 404s on every receipt a reviewer produces,
// which is what a purchase failing review looks like from the inside.
//
// Apple's own guidance is therefore to try one environment and fall back to
// the other on the 404 (4040010 TransactionIdNotFoundError) that means "not
// here". APPLE_ENVIRONMENT now only picks which to try FIRST — a dev or
// staging deployment saves a round trip, and no deployment is ever blind to
// half of Apple. What the answer is worth is a separate question, decided by
// the environment the winning lookup reports: see config.apple.sandboxCreditCapGbp.
function appStoreBaseUrls() {
  return config.apple.environment === 'sandbox'
    ? [SANDBOX_BASE_URL, PRODUCTION_BASE_URL]
    : [PRODUCTION_BASE_URL, SANDBOX_BASE_URL];
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

// Get Transaction Info — the consumable-appropriate authoritative check.
// Returns a single transaction record; no ongoing status/renewal/grace
// concept applies, unlike the subscription-status-group endpoint.
//
// A 404 from one environment is not an answer, only an absence, so it moves on
// to the next. Running out of environments is the real "no such transaction".
// Anything other than 404 — Apple down, credentials wrong — stops immediately:
// retrying the other environment would turn one outage into two and still tell
// us nothing.
async function fetchTransactionInfo(transactionId) {
  const bases = appStoreBaseUrls();
  for (let i = 0; i < bases.length; i++) {
    const res = await fetch(
      `${bases[i]}/inApps/v1/transactions/${encodeURIComponent(transactionId)}`,
      { headers: { authorization: `Bearer ${appStoreJWT()}` } }
    );
    if (res.status === 404) {
      if (i === bases.length - 1) {
        throw new VerificationError('Apple has no record of that transaction');
      }
      continue;
    }
    if (!res.ok) {
      // Apple being unavailable must not read as "this purchase doesn't exist".
      throw new VerificationError(`App Store Server API ${res.status}`, 'upstream_unavailable');
    }
    return res.json();
  }
  throw new VerificationError('Apple has no record of that transaction');
}

/**
 * Verifies an Apple consumable-purchase receipt and returns what's needed to
 * credit it.
 * @returns {{ productId, creditId, appAccountToken, environment }}
 */
// Which environment a verified transaction came from — 'production' or
// 'sandbox' — normalised, and rejected outright if it is neither.
//
// This used to throw on sandbox altogether, and the reasoning behind that is
// still sound as far as it goes: sandbox transactions chain to the same pinned
// Apple roots as production ones, so signature verification alone lets a free
// sandbox Apple Account mint unlimited genuinely-valid receipts. What it got
// wrong was the remedy. Refusing them outright also refuses App Review, which
// transacts in sandbox exactly like TestFlight does, so the app could never
// demonstrate a working purchase and the in-app purchases could never be
// approved — which is the state they have been stuck in.
//
// So the environment is no longer a gate, it is a price: a sandbox purchase
// verifies and credits like any other, up to a lifetime ceiling per subject
// (creditTopUp in app.js). Enough for a reviewer to walk the whole loop — buy,
// see the balance, talk to the coach — while a leaked sandbox account is worth
// one top-up of tokens rather than an open tap.
export function creditableEnvironment(environment) {
  // Pre-StoreKit-2 payloads don't carry the field at all; StoreKit 2 always
  // stamps it, so anything arriving without one predates the sandbox question
  // and is treated as production, exactly as it always has been.
  if (!environment) return 'production';
  const env = String(environment).toLowerCase();
  if (env === 'production' || env === 'sandbox') return env;
  throw new VerificationError(`receipt is from the ${environment} environment`);
}

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
  let environment = creditableEnvironment(payload.environment);
  if (payload.productId && !findTopUp('apple', payload.productId)) {
    throw new VerificationError('receipt is for an unknown product');
  }

  const transactionId = String(payload.transactionId || '');
  if (!transactionId) throw new VerificationError('receipt has no transaction id');
  if (payload.revocationDate) throw new VerificationError('that purchase was refunded');

  let productId = payload.productId || '';
  let appAccountToken = payload.appAccountToken || '';

  // Authoritative pass, when we have the credentials for it.
  if (config.apple.issuerId && config.apple.privateKey && config.apple.keyId) {
    const record = await fetchTransactionInfo(transactionId);
    if (!record.signedTransactionInfo) throw new VerificationError('Apple has no record of that transaction');
    const info = config.allowUnverifiedReceipts
      ? decodeJWS(record.signedTransactionInfo).payload
      : verifyAppleJWS(record.signedTransactionInfo);
    if (info.revocationDate) throw new VerificationError('that purchase was refunded');
    // The authoritative record wins over the client's copy: it is what Apple
    // says now, and it is what the credit cap gets priced on.
    environment = creditableEnvironment(info.environment);
    productId = info.productId || productId;
    appAccountToken = info.appAccountToken || appAccountToken;
  }

  // Every purchase this app starts passes .appAccountToken (see
  // IntentionStore.purchase), so a fully verified transaction *without* one
  // cannot have come from our own purchase flow — it was redeemed against an
  // App Store promo code. For a consumable that absence is the only
  // discriminator StoreKit offers, since offerType/offerDiscountType are
  // subscription-only fields, and it is a sound one: the transaction is still
  // Apple-signed, bundle-checked, environment-checked, refund-checked and
  // credited exactly once by transaction id. The client asserts its own
  // account token for these (see verifyEndpoint in app.js), which is what
  // gives the grant a balance to land in.
  return {
    productId,
    creditId: transactionId,
    appAccountToken,
    environment,
    isPromo: !appAccountToken
  };
}
