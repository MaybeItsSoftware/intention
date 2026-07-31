import { config } from './config.js';
import { verifyAppleReceipt, VerificationError } from './apple.js';
import { verifyGooglePurchase } from './google.js';
import { signToken, verifyToken, subjectFor, TokenError } from './tokens.js';
import { consumeQuota, generateAccessCode, redeemAccessCode, store } from './store.js';
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
      case '/v1/entitlement/verify': return await verifyEndpoint(body, deps);
      case '/v1/entitlement/refresh': return await refreshEndpoint(body, deps);
      case '/v1/entitlement/code': return codeEndpoint(headers, backing);
      case '/v1/entitlement/redeem': return redeemEndpoint(body, backing);
      case '/v1/chat': return await chatEndpoint(headers, body, deps, backing);
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

async function verifyEndpoint(body, deps) {
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

  return json(200, entitlementResponse(platform, result));
}

async function refreshEndpoint(body, deps) {
  const claims = verifyToken(body?.token, config.tokenSecret);
  // A refresh has to go back to the store: the whole point is catching a
  // renewal or a refund that happened since the token was minted. Without the
  // original receipt to re-check, the token is simply re-issued at its
  // existing expiry, which is bounded by tokenTtlMs anyway.
  if (!claims.receipt) {
    return json(200, entitlementResponse(claims.platform, {
      active: true,
      productId: claims.productId,
      expiresAt: claims.subscriptionExpiresAt || null,
      originalTransactionId: claims.originalTransactionId
    }));
  }

  const verify = claims.platform === 'apple'
    ? (deps.verifyApple || verifyAppleReceipt)
    : (deps.verifyGoogle || verifyGooglePurchase);
  const result = await verify(claims.receipt);
  return json(200, entitlementResponse(claims.platform, result));
}

function entitlementResponse(platform, result) {
  const subject = subjectFor(platform, result.originalTransactionId);
  const payload = {
    sub: subject,
    platform,
    productId: result.productId,
    originalTransactionId: result.originalTransactionId,
    subscriptionExpiresAt: result.expiresAt || null
  };
  // The token's own life is capped at tokenTtlMs, and never outlives the
  // subscription it stands for — so a cancelled plan can't keep working for a
  // week just because the token hadn't expired yet.
  const ttl = result.expiresAt
    ? Math.max(0, Math.min(config.tokenTtlMs, Number(result.expiresAt) - Date.now()))
    : config.tokenTtlMs;

  return {
    active: !!result.active,
    productId: result.productId || '',
    expiresAt: result.expiresAt || null,
    plan: result.productId || '',
    token: result.active ? signToken(payload, config.tokenSecret, ttl) : '',
    quota: { daily: config.dailyMessageQuota }
  };
}

// A signed-in mobile app mints a short-lived code so the same subscription can
// unlock the browser extension, where there is no store to buy through.
function codeEndpoint(headers, backing) {
  const claims = verifyToken(bearer(headers), config.tokenSecret);
  const { code, expiresAt } = generateAccessCode({
    sub: claims.sub,
    platform: claims.platform,
    productId: claims.productId,
    originalTransactionId: claims.originalTransactionId,
    subscriptionExpiresAt: claims.subscriptionExpiresAt || null
  }, { backing });
  return json(200, { code, expiresAt });
}

function redeemEndpoint(body, backing) {
  const claims = redeemAccessCode(body?.code, backing);
  if (!claims) {
    return json(404, { error: 'That code is not valid or has already been used.', code: 'entitlement_invalid' });
  }
  const ttl = claims.subscriptionExpiresAt
    ? Math.max(0, Math.min(config.tokenTtlMs, Number(claims.subscriptionExpiresAt) - Date.now()))
    : config.tokenTtlMs;
  return json(200, {
    active: ttl > 0,
    productId: claims.productId || '',
    expiresAt: claims.subscriptionExpiresAt || null,
    plan: claims.productId || '',
    token: ttl > 0 ? signToken(claims, config.tokenSecret, ttl) : '',
    quota: { daily: config.dailyMessageQuota }
  });
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

  const quota = consumeQuota(claims.sub, config.dailyMessageQuota, backing);
  if (!quota.allowed) {
    return json(429, {
      error: "You've used all of today's coaching messages.",
      code: 'quota_exceeded',
      quota
    });
  }

  const llm = deps.callCoachLLM || callCoachLLM;
  const result = await llm({
    system: typeof body.system === 'string' ? body.system : '',
    messages,
    tools: Array.isArray(body.tools) ? body.tools : []
  });

  return json(200, { text: result.text || '', toolCalls: result.toolCalls || [], quota });
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
