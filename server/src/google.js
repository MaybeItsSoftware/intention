import crypto from 'node:crypto';
import { config } from './config.js';
import { VerificationError } from './apple.js';

// Google Play purchase verification via the Play Developer API.
//
// The client sends { purchaseToken, productId } straight from Play Billing.
// A purchase token means nothing on its own — it has to be exchanged with
// Google for the subscription's real state, which is what this does.

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

// subscriptionsv2 states that still mean "this person is paying".
const ALLOWED_STATES = new Set([
  'SUBSCRIPTION_STATE_ACTIVE',
  'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
  'SUBSCRIPTION_STATE_CANCELED' // cancelled but not yet expired — access runs to the end of the term
]);

/**
 * @returns {{ active, productId, expiresAt, originalTransactionId }}
 */
export async function verifyGooglePurchase(receipt) {
  const purchaseToken = receipt && receipt.purchaseToken;
  const productId = (receipt && receipt.productId) || '';
  if (!purchaseToken) throw new VerificationError('purchase token missing');
  if (productId && !config.google.productIds.includes(productId)) {
    throw new VerificationError('purchase is for an unknown product');
  }

  if (config.allowUnverifiedReceipts) {
    return {
      active: true,
      productId,
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
      originalTransactionId: purchaseToken.slice(0, 64)
    };
  }

  const token = await accessToken();
  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/`
    + `${encodeURIComponent(config.google.packageName)}/purchases/subscriptionsv2/tokens/`
    + `${encodeURIComponent(purchaseToken)}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 404 || res.status === 410) {
    throw new VerificationError('Google has no record of that purchase');
  }
  if (!res.ok) {
    throw new VerificationError(`Play Developer API ${res.status}`, 'upstream_unavailable');
  }
  const data = await res.json();

  const line = (data.lineItems || [])[0] || {};
  const expiryTime = line.expiryTime || data.lineItems?.[0]?.expiryTime;
  const expiresAt = expiryTime ? new Date(expiryTime).getTime() : null;
  const active = ALLOWED_STATES.has(data.subscriptionState)
    && (!expiresAt || expiresAt > Date.now());

  return {
    active,
    productId: line.productId || productId,
    expiresAt,
    // Play's linkedPurchaseToken chain means the token can change across
    // upgrades; the order id is the stable handle for one subscription.
    originalTransactionId: String(data.latestOrderId || purchaseToken).split('..')[0]
  };
}
