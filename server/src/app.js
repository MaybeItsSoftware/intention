import { config, findTopUp, creditMicrosForTopUp, microsToCredits } from './config.js';
import { verifyAppleReceipt, VerificationError } from './apple.js';
import { verifyGooglePurchase, consumePurchase } from './google.js';
import { signToken, verifyToken, subjectFor, TokenError } from './tokens.js';
import {
  adjustBalance, getBalanceMicros, alreadyCredited, markCredited,
  generateAccessCode, redeemAccessCode, store
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
    markCredited(platform, result.creditId, backing);
    const topUp = findTopUp(platform, result.productId);
    if (topUp) adjustBalance(subject, creditMicrosForTopUp(platform, topUp.priceGbp), backing);
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
