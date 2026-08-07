import crypto from 'node:crypto';
import { config, findTopUp } from './config.js';
import { VerificationError } from './apple.js';

// Google Play purchase verification for a consumable coaching-credit top-up,
// via the Play Developer API.
//
// The client sends { purchaseToken, productId } straight from Play Billing.
// A purchase token means nothing on its own — it has to be exchanged with
// Google for the purchase's real state, which is what this does. There is no
// "subscription status" for a one-time product: Google's equivalent is the
// one-time-products endpoint (purchaseState/consumptionState), not
// subscriptionsv2.

let cachedAccessToken = null;

// Service-account OAuth2: sign a JWT with the account's private key and swap
// it for an access token. Cached until shortly before it expires.
async function accessToken() {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60_000) {
    return cachedAccessToken.value;
  }
  const { clientEmail, privateKey } = config.google;
  if (!clientEmail || !privateKey) {
    throw new VerificationError('Play Developer API is not configured', 'upstream_unavailable');
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };
  const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const signingInput = `${encode(header)}.${encode(claims)}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput), privateKey).toString('base64url');
  const assertion = `${signingInput}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });
  if (!res.ok) {
    throw new VerificationError(`Google token exchange ${res.status}`, 'upstream_unavailable');
  }
  const data = await res.json();
  cachedAccessToken = {
    value: data.access_token,
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000
  };
  return cachedAccessToken.value;
}

function productsUrl(productId, purchaseToken) {
  return `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/`
    + `${encodeURIComponent(config.google.packageName)}/purchases/products/`
    + `${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}`;
}

// purchaseState: 0 purchased, 1 canceled, 2 pending. Only a completed
// purchase is creditable — a consumable has no renewal/grace concept.
const CREDITABLE_PURCHASE_STATE = 0;

// The creditability rules over the Play Developer API's purchase record.
// Exported so the rules are testable without the network exchange around them.
export function assertCreditablePlayPurchase(data) {
  if (Number(data.purchaseState) !== CREDITABLE_PURCHASE_STATE) {
    throw new VerificationError('that purchase was cancelled or is still pending');
  }
  // purchaseType is only present for non-standard purchases: 0 test (licence
  // tester), 1 promo code, 2 rewarded. None of those moved real money, so
  // none of them may mint real coaching credit unless explicitly allowed for
  // a dev/staging deployment.
  if (data.purchaseType !== undefined && !config.google.allowTestPurchases) {
    throw new VerificationError('test and promo purchases are not creditable');
  }
  if (!data.obfuscatedExternalAccountId) {
    throw new VerificationError('purchase has no linked account token');
  }
}

/**
 * @returns {{ productId, creditId, purchaseToken, obfuscatedExternalAccountId }}
 */
export async function verifyGooglePurchase(receipt) {
  const purchaseToken = receipt && receipt.purchaseToken;
  const productId = (receipt && receipt.productId) || '';
  if (!purchaseToken) throw new VerificationError('purchase token missing');
  if (!productId || !findTopUp('google', productId)) {
    throw new VerificationError('purchase is for an unknown product');
  }

  if (config.allowUnverifiedReceipts) {
    return {
      productId,
      creditId: purchaseToken.slice(0, 64),
      purchaseToken,
      obfuscatedExternalAccountId: `dev:${purchaseToken.slice(0, 32)}`
    };
  }

  const token = await accessToken();
  const res = await fetch(productsUrl(productId, purchaseToken), { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 404 || res.status === 410) {
    throw new VerificationError('Google has no record of that purchase');
  }
  if (!res.ok) {
    throw new VerificationError(`Play Developer API ${res.status}`, 'upstream_unavailable');
  }
  const data = await res.json();

  assertCreditablePlayPurchase(data);

  return {
    productId,
    creditId: String(data.orderId || purchaseToken),
    purchaseToken,
    obfuscatedExternalAccountId: data.obfuscatedExternalAccountId
  };
}

// Marks a one-time product as consumed so it becomes purchasable again for
// this user — Google's own authoritative "this token is spent" record.
// Belt-and-braces alongside the server's own idempotency key, not the
// primary guard against double-crediting (see store.js).
export async function consumePurchase(productId, purchaseToken) {
  const token = await accessToken();
  const res = await fetch(`${productsUrl(productId, purchaseToken)}:consume`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` }
  });
  if (!res.ok) {
    throw new VerificationError(`Play Developer API consume ${res.status}`, 'upstream_unavailable');
  }
}
