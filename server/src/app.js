import { config, findTopUp, creditMicrosForTopUp, microsToCredits } from './config.js';
import { verifyAppleReceipt, verifyAppleJWS, decodeJWS, VerificationError } from './apple.js';
import { verifyGooglePurchase, consumePurchase } from './google.js';
import { signToken, verifyToken, subjectFor, TokenError } from './tokens.js';
import {
  adjustBalance, getBalanceMicros, alreadyCredited, markCredited,
  getCreditRecord, refundTopUp, generateAccessCode, redeemAccessCode, store
} from './store.js';
import { callCoachLLM, UpstreamError } from './llm.js';

// Request handling, kept transport-agnostic: `handleRequest` takes a plain
// { method, path, headers, body } and returns { status, body }. index.js wraps
// it in a node:http server; tests call it directly.

const MAX_MESSAGES = 60;
const MAX_CONTENT_CHARS = 8000;

export async function handleRequest({ method, path, headers = {}, body = null }, deps = {}) {
  const backing = deps.store || store;

  if (method === 'GET' && path === '/health') {
    return json(200, { ok: true });
  }
  if (method !== 'POST') {
    return json(405, { error: 'Method not allowed', code: 'method_not_allowed' });
  }

  try {
    switch (path) {
      case '/v1/entitlement/verify': return await verifyEndpoint(body, deps, backing);
      case '/v1/entitlement/refresh': return refreshEndpoint(body, backing);
      case '/v1/entitlement/code': return codeEndpoint(headers, backing);
      case '/v1/entitlement/redeem': return redeemEndpoint(body, backing);
      case '/v1/chat': return await chatEndpoint(headers, body, deps, backing);
      case '/v1/webhooks/apple': return await appleWebhookEndpoint(body, deps, backing);
      case '/v1/webhooks/google': return await googleWebhookEndpoint(body, headers, deps, backing);
      default:
        return json(404, { error: 'Not found', code: 'not_found' });
    }
  } catch (e) {
    if (e instanceof TokenError || e instanceof VerificationError) {
      const status = e.code === 'upstream_unavailable' ? 503
        : e.code === 'entitlement_expired' ? 402
        : 401;
      return json(status, { error: e.message, code: e.code });
    }
    if (e instanceof UpstreamError) {
      return json(e.status, { error: e.message, code: 'upstream_error' });
    }
    console.error('[intention] unhandled error', e);
    return json(500, { error: 'Internal error', code: 'internal_error' });
  }
}

// ---- Entitlement ----------------------------------------------------------

async function verifyEndpoint(body, deps, backing) {
  const platform = body?.platform;
  const receipt = body?.receipt;
  if (!platform || !receipt) {
    return json(400, { error: 'platform and receipt are required', code: 'bad_request' });
  }

  let result;
  if (platform === 'apple') {
    result = await (deps.verifyApple || verifyAppleReceipt)(receipt);
  } else if (platform === 'google') {
    result = await (deps.verifyGoogle || verifyGooglePurchase)(receipt);
  } else {
    return json(400, { error: `Unknown platform: ${platform}`, code: 'bad_request' });
  }

  const accountToken = platform === 'apple' ? result.appAccountToken : result.obfuscatedExternalAccountId;
  const subject = subjectFor(platform, accountToken);
  await creditTopUp(platform, subject, result, backing, deps);
  return json(200, entitlementResponse(subject, platform, result.productId, backing));
}

// A refresh only proves the token is still valid and reports the current
// balance — it never re-grants credit. Granting only ever happens once, at
// verify time, guarded by the idempotency key in creditTopUp.
function refreshEndpoint(body, backing) {
  const claims = verifyToken(body?.token, config.tokenSecret);
  return json(200, entitlementResponse(claims.sub, claims.platform, claims.productId, backing));
}

// Credits a top-up exactly once per store purchase (keyed by the
// transaction/order id, never combined with subject — the same account tops
// up repeatedly, but each individual purchase is creditable only once).
async function creditTopUp(platform, subject, result, backing, deps = {}) {
  if (!alreadyCredited(platform, result.creditId, backing)) {
    const topUp = findTopUp(platform, result.productId);
    const creditMicros = topUp ? creditMicrosForTopUp(platform, topUp.priceGbp) : 0;
    const record = {
      subject,
      productId: result.productId,
      creditMicros,
      creditedAt: Date.now(),
      refunded: false,
      creditId: result.creditId,
      purchaseToken: result.purchaseToken || null,
      orderId: result.creditId
    };
    markCredited(platform, result.creditId, record, backing);
    if (result.purchaseToken && result.purchaseToken !== result.creditId) {
      markCredited(platform, result.purchaseToken, record, backing);
    }
    if (creditMicros > 0) adjustBalance(subject, creditMicros, backing);
  }
  if (platform === 'google') {
    // Google's own authoritative "this token is spent" record — insurance
    // alongside the idempotency key above, not the primary guard.
    try {
      await (deps.consumeGoogle || consumePurchase)(result.productId, result.purchaseToken);
    } catch (e) {
      console.error('[intention] Google consume failed (balance already credited)', e);
    }
  }
}

// ---- Refund Webhooks ------------------------------------------------------

async function appleWebhookEndpoint(body, deps, backing) {
  const signedPayload = body?.signedPayload;
  if (!signedPayload) {
    return json(400, { error: 'signedPayload is required', code: 'bad_request' });
  }

  const verifier = deps.verifyAppleJWS || (config.allowUnverifiedReceipts ? (jws) => decodeJWS(jws).payload : verifyAppleJWS);
  let notification;
  try {
    notification = verifier(signedPayload);
  } catch (e) {
    if (e instanceof VerificationError) {
      return json(401, { error: e.message, code: e.code });
    }
    throw e;
  }

  const notificationType = notification?.notificationType;
  const signedTransactionInfo = notification?.data?.signedTransactionInfo;

  if (signedTransactionInfo) {
    let info;
    try {
      info = verifier(signedTransactionInfo);
    } catch (e) {
      if (e instanceof VerificationError) {
        return json(401, { error: e.message, code: e.code });
      }
      throw e;
    }

    const transactionId = String(info.transactionId || info.originalTransactionId || '');
    const appAccountToken = info.appAccountToken || '';
    const productId = info.productId || '';

    if (notificationType === 'REFUND' || notificationType === 'REVOKE' || info.revocationDate) {
      const subject = appAccountToken ? subjectFor('apple', appAccountToken) : null;
      const result = refundTopUp('apple', transactionId, { subject, productId }, backing);
      return json(200, { ok: true, refund: result });
    }
  }

  return json(200, { ok: true, processed: false, notificationType: notificationType || '' });
}

async function googleWebhookEndpoint(body, headers, deps, backing) {
  const secret = config.google.webhookSecret;
  if (secret) {
    const authHeader = headers.authorization || headers.Authorization || '';
    const tokenQuery = body?.token;
    if (authHeader !== `Bearer ${secret}` && tokenQuery !== secret) {
      return json(401, { error: 'Unauthorized webhook request', code: 'unauthorized' });
    }
  }

  if (body?.testNotification) {
    return json(200, { ok: true, test: true });
  }

  const messageData = body?.message?.data;
  if (!messageData) {
    return json(400, { error: 'message.data is required', code: 'bad_request' });
  }

  let payload;
  try {
    const jsonString = Buffer.from(messageData, 'base64').toString('utf8');
    payload = JSON.parse(jsonString);
  } catch (e) {
    return json(400, { error: 'Invalid message payload', code: 'bad_request' });
  }

  if (payload.testNotification) {
    return json(200, { ok: true, test: true });
  }

  const otp = payload.oneTimeProductNotification;
  const voided = payload.voidedPurchaseNotification;

  const isCanceled = (otp && Number(otp.notificationType) === 2) || Boolean(voided);
  if (!isCanceled) {
    return json(200, { ok: true, processed: false });
  }

  const purchaseToken = otp?.purchaseToken || voided?.purchaseToken || '';
  const orderId = voided?.orderId || '';
  const productId = otp?.sku || voided?.sku || '';

  const creditId = orderId || purchaseToken;
  if (!creditId) {
    return json(400, { error: 'No orderId or purchaseToken in notification', code: 'bad_request' });
  }

  let subject = null;
  const existing = getCreditRecord('google', creditId, backing) || (purchaseToken ? getCreditRecord('google', purchaseToken, backing) : null);
  if (existing?.subject) {
    subject = existing.subject;
  } else if (purchaseToken && (deps.verifyGoogle || (config.google.clientEmail && config.google.privateKey))) {
    try {
      const verifier = deps.verifyGoogle || verifyGooglePurchase;
      const verified = await verifier({ purchaseToken, productId });
      if (verified?.obfuscatedExternalAccountId) {
        subject = subjectFor('google', verified.obfuscatedExternalAccountId);
      }
    } catch (e) {
      // Ignore if verification fails or already voided
    }
  }

  const result = refundTopUp('google', creditId, { subject, productId }, backing);
  return json(200, { ok: true, refund: result });
}

function entitlementResponse(subject, platform, productId, backing) {
  const balanceMicros = getBalanceMicros(subject, backing);
  const payload = { sub: subject, platform, productId };
  return {
    active: balanceMicros > 0,
    productId: productId || '',
    balanceMicros,
    balanceGbp: microsToGbp(balanceMicros),
    balanceCredits: microsToCredits(balanceMicros),
    // A token proves "known, verified purchaser," not "has balance" — it's
    // always issued so a zero-balance account can still refresh/top up.
    token: signToken(payload, config.tokenSecret, config.tokenTtlMs)
  };
}

function microsToGbp(micros) {
  return Math.round(micros / 10000) / 100;
}

// A signed-in mobile app mints a short-lived code so the same credit balance
// can unlock the browser extension, where there is no store to buy through.
function codeEndpoint(headers, backing) {
  const claims = verifyToken(bearer(headers), config.tokenSecret);
  const { code, expiresAt } = generateAccessCode({
    sub: claims.sub,
    platform: claims.platform,
    productId: claims.productId
  }, { backing });
  return json(200, { code, expiresAt });
}

function redeemEndpoint(body, backing) {
  const claims = redeemAccessCode(body?.code, backing);
  if (!claims) {
    return json(404, { error: 'That code is not valid or has already been used.', code: 'entitlement_invalid' });
  }
  return json(200, entitlementResponse(claims.sub, claims.platform, claims.productId, backing));
}

// ---- Coaching proxy -------------------------------------------------------

async function chatEndpoint(headers, body, deps, backing) {
  const claims = verifyToken(bearer(headers), config.tokenSecret);

  const messages = Array.isArray(body?.messages) ? body.messages : null;
  if (!messages || !messages.length) {
    return json(400, { error: 'messages are required', code: 'bad_request' });
  }
  if (messages.length > MAX_MESSAGES) {
    return json(400, { error: 'conversation too long', code: 'bad_request' });
  }
  for (const message of messages) {
    if (!message || typeof message.content !== 'string' || message.content.length > MAX_CONTENT_CHARS) {
      return json(400, { error: 'malformed message', code: 'bad_request' });
    }
    if (message.role !== 'user' && message.role !== 'assistant') {
      return json(400, { error: 'malformed message role', code: 'bad_request' });
    }
  }

  const balanceMicros = getBalanceMicros(claims.sub, backing);
  if (balanceMicros <= 0) {
    return json(402, {
      error: "You're out of coaching credit. Buy more to keep talking to your coach.",
      code: 'balance_exhausted',
      balanceMicros: 0,
      balanceGbp: 0,
      balanceCredits: 0
    });
  }

  const llm = deps.callCoachLLM || callCoachLLM;
  const result = await llm({
    system: typeof body.system === 'string' ? body.system : '',
    messages,
    tools: Array.isArray(body.tools) ? body.tools : []
  });

  // Deducted after the fact, from the real cost of what was just used — the
  // balance is only checked (not reserved) up front, so one message can push
  // it slightly negative; that's expected prepaid-metering behaviour and
  // corrects itself on the next top-up.
  const usage = result.usage || { inputTokens: 0, outputTokens: 0 };
  const pricing = config.llm.pricing[config.llm.model] || config.llm.pricing.default;
  const costUsd = (usage.inputTokens * pricing.inputPerMillionUsd + usage.outputTokens * pricing.outputPerMillionUsd) / 1_000_000;
  const costMicros = Math.ceil(costUsd * config.llm.usdToGbpRate * config.llm.marginMultiplier * 1_000_000);
  const newBalance = adjustBalance(claims.sub, -costMicros, backing);

  return json(200, {
    text: result.text || '',
    toolCalls: result.toolCalls || [],
    balanceMicros: newBalance,
    balanceGbp: microsToGbp(newBalance),
    balanceCredits: microsToCredits(newBalance)
  });
}

// ---- helpers --------------------------------------------------------------

function bearer(headers) {
  const raw = headers.authorization || headers.Authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(raw);
  return match ? match[1].trim() : '';
}

function json(status, body) {
  return { status, body };
}
