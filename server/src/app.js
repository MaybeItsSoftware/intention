import { config, findTopUp, creditMicrosForTopUp, microsToCredits } from './config.js';
import { verifyAppleReceipt, verifyAppleJWS, decodeJWS, VerificationError } from './apple.js';
import { verifyGooglePurchase, consumePurchase } from './google.js';
import { signToken, verifyToken, subjectFor, safeEqualString, TokenError } from './tokens.js';
import {
  adjustBalance, getBalanceMicros, alreadyCredited, markCredited,
  getCreditRecord, refundTopUp, generateAccessCode, redeemAccessCode,
  getTokenVersion, store
} from './store.js';
import { callCoachLLM, UpstreamError } from './llm.js';
import { reservations } from './reservations.js';
import { rateLimiter } from './ratelimit.js';
import { logEvent } from './log.js';

// Request handling, kept transport-agnostic: `handleRequest` takes a plain
// { method, path, headers, body, ip, query } and returns { status, body }.
// index.js wraps it in a node:http server; tests call it directly.

const MAX_MESSAGES = 60;
const MAX_CONTENT_CHARS = 8000;
// The system prompt is built client-side and includes user-editable
// coachInstructions, so this is sized from measurement, not guessed: the
// largest realistic buildGateSystemPrompt output (every context field full,
// default instructions) is ~12.5k chars, so 32k leaves room for elaborate
// custom instructions while still bounding the field.
const MAX_SYSTEM_CHARS = 32_000;
// The block-array form of `system` exists purely for prompt-cache
// breakpoints, and Anthropic honours at most 4 cache_control markers per
// request — more blocks than that could never buy anything.
const MAX_SYSTEM_BLOCKS = 4;
// Per-field caps multiply: 60 messages x 8k chars is 480k chars ≈ 120k input
// tokens on a single call, purchasable with one micro of credit. The
// aggregate cap is the real cost bound; it comfortably fits the client's
// 40-message transcript window plus prompt and tools.
const MAX_TOTAL_INPUT_CHARS = 120_000;
const MAX_TOOLS = 8;
const TOOL_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const MAX_TOOL_DESCRIPTION_CHARS = 2_000;
const MAX_TOOL_SCHEMA_CHARS = 4_000;
const MAX_TOOL_SCHEMA_DEPTH = 8;
// Not about credit — that's the reservation below. This stops one token pinning
// a pile of simultaneous upstream calls and burning the provider rate limit.
const MAX_INFLIGHT_PER_SUBJECT = 2;

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// Per-IP limits on everything reachable without a token, checked before the
// route switch so expensive work (receipt verification, JWS parsing) never
// starts for a flood. Sized well above legitimate client behaviour — verify
// fires on app launch, redeem once per browser link.
const IP_LIMITS = {
  '/v1/entitlement/verify': { limit: 30, windowMs: 10 * MINUTE },
  '/v1/entitlement/refresh': { limit: 60, windowMs: 10 * MINUTE },
  '/v1/entitlement/redeem': { limit: 30, windowMs: HOUR },
  '/v1/webhooks/apple': { limit: 120, windowMs: MINUTE },
  '/v1/webhooks/google': { limit: 120, windowMs: MINUTE }
};

// Failed redemptions are tracked separately from volume: a miss means someone
// is guessing codes, and this bound is what makes the short human-typeable
// format safe against brute force (32^8 codes at 10 misses/hour/IP).
const REDEEM_FAILS = { limit: 10, windowMs: HOUR };

// Per-subject limits, checked inside the endpoints once the token is known.
const CHAT_LIMIT = { limit: 30, windowMs: MINUTE };
const CODE_LIMIT = { limit: 10, windowMs: HOUR };

export async function handleRequest({ method, path, headers = {}, body = null, query = {}, ip = '' }, deps = {}) {
  const backing = deps.store || store;
  const limiter = deps.rateLimiter || rateLimiter;

  if (method === 'GET' && path === '/health') {
    // Readiness, not liveness: a store round-trip (a real write, so a
    // FileStore whose volume unmounted after boot fails here rather than at
    // the next purchase). Boot-time config problems already stop the process.
    try {
      backing.set('health:probe', Date.now(), 60_000);
      if (!(Number(backing.get('health:probe')) > 0)) throw new Error('probe read back empty');
      return json(200, { ok: true });
    } catch (e) {
      console.error('[intention] health probe failed', e);
      return json(503, { ok: false, code: 'store_unavailable' });
    }
  }
  if (method !== 'POST') {
    return json(405, { error: 'Method not allowed', code: 'method_not_allowed' });
  }

  const ipLimit = IP_LIMITS[path];
  if (ipLimit && !limiter.check(`ip:${path}`, ip || 'unknown', ipLimit.limit, ipLimit.windowMs)) {
    return rateLimited();
  }

  try {
    switch (path) {
      case '/v1/entitlement/verify': return await verifyEndpoint(body, deps, backing);
      case '/v1/entitlement/refresh': return refreshEndpoint(body, backing);
      case '/v1/entitlement/code': return codeEndpoint(headers, backing, limiter);
      case '/v1/entitlement/redeem': return redeemEndpoint(body, backing, limiter, ip);
      case '/v1/chat': return await chatEndpoint(headers, body, deps, backing, limiter);
      case '/v1/webhooks/apple': return await appleWebhookEndpoint(body, deps, backing);
      case '/v1/webhooks/google': return await googleWebhookEndpoint(body, headers, deps, backing, query);
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
  const claims = assertTokenCurrent(verifyToken(body?.token, config.tokenSecret), backing);
  return json(200, entitlementResponse(claims.sub, claims.platform, claims.productId, backing, claims));
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

    // Any Apple-signed transaction passes the JWS walk — including other
    // developers' — so without this check anyone could replay a foreign
    // signed transaction and trigger a clawback here.
    const bundleId = info.bundleId || notification?.data?.bundleId || '';
    if (bundleId && bundleId !== config.apple.bundleId) {
      return json(401, { error: 'notification is for a different app', code: 'unauthorized' });
    }
    // A sandbox notification is genuine Apple traffic during TestFlight
    // testing, so acknowledge rather than 401 (Apple retries on non-2xx) —
    // but it must never claw back production credit.
    const environment = info.environment || notification?.data?.environment || '';
    if (environment && String(environment).toLowerCase() !== 'production' && config.apple.environment !== 'sandbox') {
      return json(200, { ok: true, processed: false, reason: 'non-production environment' });
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

async function googleWebhookEndpoint(body, headers, deps, backing, query = {}) {
  const secret = config.google.webhookSecret;
  // Fail closed. This endpoint deducts credit, so an unconfigured secret used
  // to mean anyone could POST a voidedPurchaseNotification and claw back
  // another account's balance.
  if (!secret) {
    return json(503, {
      error: 'Refund webhook is not configured',
      code: 'not_configured'
    });
  }
  // Pub/Sub push subscriptions cannot set arbitrary request headers, so the
  // query parameter is the form that actually works for real RTDN traffic —
  // and the one DEPLOYMENT.md documents. The bearer header is kept for manual
  // testing. The body path that used to be read here never fired for real
  // Pub/Sub traffic (whose body is {message, subscription}) and put the secret
  // somewhere request-body logging would capture it.
  const authHeader = headers.authorization || headers.Authorization || '';
  const presented = authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length)
    : (query.token || '');
  if (!safeEqualString(presented, secret)) {
    return json(401, { error: 'Unauthorized webhook request', code: 'unauthorized' });
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

function entitlementResponse(subject, platform, productId, backing, priorClaims = null) {
  const balanceMicros = getBalanceMicros(subject, backing);
  const now = Date.now();
  // A refresh used to rebuild the payload from scratch, so every refresh
  // stamped a fresh full TTL — tokens were infinitely renewable. The original
  // issue time now rides along, and the lineage dies at the absolute
  // lifetime; the client then re-verifies from its stored receipt.
  const origIat = Number(priorClaims?.origIat) || now;
  const exp = Math.min(now + config.tokenTtlMs, origIat + config.tokenMaxLifetimeMs);
  const payload = {
    sub: subject,
    platform,
    productId,
    origIat,
    tv: getTokenVersion(subject, backing),
    exp
  };
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

// Checked after every verifyToken: a token whose version is behind the
// subject's current one has been revoked (bumpTokenVersion), whatever its exp
// says. Missing tv means a pre-versioning token, which counts as version 0.
function assertTokenCurrent(claims, backing) {
  if (Number(claims.tv || 0) !== getTokenVersion(claims.sub, backing)) {
    throw new TokenError('token has been revoked');
  }
  return claims;
}

function microsToGbp(micros) {
  return Math.round(micros / 10000) / 100;
}

// A signed-in mobile app mints a short-lived code so the same credit balance
// can unlock the browser extension, where there is no store to buy through.
function codeEndpoint(headers, backing, limiter) {
  const claims = assertTokenCurrent(verifyToken(bearer(headers), config.tokenSecret), backing);
  if (!limiter.check('code', claims.sub, CODE_LIMIT.limit, CODE_LIMIT.windowMs)) {
    return rateLimited();
  }
  const { code, expiresAt } = generateAccessCode({
    sub: claims.sub,
    platform: claims.platform,
    productId: claims.productId
  }, { backing });
  return json(200, { code, expiresAt });
}

function redeemEndpoint(body, backing, limiter, ip) {
  if (limiter.atLimit('redeem-fail', ip || 'unknown', REDEEM_FAILS.limit)) {
    return rateLimited();
  }
  const claims = redeemAccessCode(body?.code, backing);
  if (!claims) {
    limiter.record('redeem-fail', ip || 'unknown', REDEEM_FAILS.windowMs);
    return json(404, { error: 'That code is not valid or has already been used.', code: 'entitlement_invalid' });
  }
  return json(200, entitlementResponse(claims.sub, claims.platform, claims.productId, backing));
}

// ---- Coaching proxy -------------------------------------------------------

async function chatEndpoint(headers, body, deps, backing, limiter) {
  const claims = assertTokenCurrent(verifyToken(bearer(headers), config.tokenSecret), backing);
  if (!limiter.check('chat', claims.sub, CHAT_LIMIT.limit, CHAT_LIMIT.windowMs)) {
    return rateLimited();
  }

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

  // `system` is either a bare string (older clients) or an array of up to
  // MAX_SYSTEM_BLOCKS text blocks — the array form lets the client mark its
  // stable prompt prefix cacheable ({ text, cache: true }) while the volatile
  // suffix stays uncached. Both normalize to a block array here so llm.js
  // only ever sees one shape. Validate rather than coerce: anything else is a
  // malformed request, not an empty prompt.
  let system = [];
  if (typeof body.system === 'string') {
    if (body.system) system = [{ text: body.system }];
  } else if (Array.isArray(body.system)) {
    if (body.system.length > MAX_SYSTEM_BLOCKS) {
      return json(400, { error: 'too many system blocks', code: 'bad_request' });
    }
    for (const block of body.system) {
      if (!block || typeof block !== 'object' || Array.isArray(block) || typeof block.text !== 'string') {
        return json(400, { error: 'system must be a string or an array of text blocks', code: 'bad_request' });
      }
    }
    system = body.system.map(b => (b.cache ? { text: b.text, cache: true } : { text: b.text }));
  } else if (body.system !== undefined) {
    return json(400, { error: 'system must be a string or an array of text blocks', code: 'bad_request' });
  }
  const systemChars = system.reduce((sum, b) => sum + b.text.length, 0);
  if (systemChars > MAX_SYSTEM_CHARS) {
    return json(400, { error: 'system prompt too long', code: 'bad_request' });
  }

  if (body.tools !== undefined && !Array.isArray(body.tools)) {
    return json(400, { error: 'tools must be an array', code: 'bad_request' });
  }
  const rawTools = body.tools || [];
  if (rawTools.length > MAX_TOOLS) {
    return json(400, { error: 'too many tools', code: 'bad_request' });
  }
  const tools = [];
  for (const tool of rawTools) {
    if (!tool || typeof tool.name !== 'string' || !TOOL_NAME_RE.test(tool.name)) {
      return json(400, { error: 'malformed tool name', code: 'bad_request' });
    }
    if (tool.description !== undefined &&
        (typeof tool.description !== 'string' || tool.description.length > MAX_TOOL_DESCRIPTION_CHARS)) {
      return json(400, { error: 'malformed tool description', code: 'bad_request' });
    }
    const schema = sanitizeToolSchema(tool.schema === undefined ? { type: 'object' } : tool.schema);
    if (schema === INVALID_SCHEMA || JSON.stringify(schema).length > MAX_TOOL_SCHEMA_CHARS) {
      return json(400, { error: 'malformed tool schema', code: 'bad_request' });
    }
    tools.push({ name: tool.name, description: tool.description || '', schema });
  }

  // The aggregate bound is what actually caps upstream cost — see the
  // constants above for why per-field caps alone are not enough.
  const totalChars = systemChars
    + messages.reduce((sum, m) => sum + m.content.length, 0)
    + JSON.stringify(tools).length;
  if (totalChars > MAX_TOTAL_INPUT_CHARS) {
    return json(400, { error: 'request too large', code: 'bad_request' });
  }

  const holds = deps.reservations || reservations;

  // Everything from here to holds.acquire() runs with no await, so no other
  // request can interleave and see this balance before it is spoken for. See
  // reservations.js — that atomicity is the whole fix.
  if (holds.inFlight(claims.sub) >= MAX_INFLIGHT_PER_SUBJECT) {
    return json(429, {
      error: 'Too many coaching requests in flight. Wait for the last one to finish.',
      code: 'too_many_inflight'
    });
  }
  const estimateMicros = estimateCostMicros({ systemChars, messages, tools });
  const availableMicros = getBalanceMicros(claims.sub, backing) - holds.heldMicros(claims.sub);
  if (availableMicros <= 0) {
    return json(402, {
      error: "You're out of coaching credit. Buy more to keep talking to your coach.",
      code: 'balance_exhausted',
      balanceMicros: 0,
      balanceGbp: 0,
      balanceCredits: 0
    });
  }
  holds.acquire(claims.sub, estimateMicros);

  const llm = deps.callCoachLLM || callCoachLLM;
  let result;
  try {
    result = await llm({ system, messages, tools });
  } finally {
    // Must run on the error path too, or a failed upstream call leaves credit
    // held against a request that will never bill.
    holds.release(claims.sub, estimateMicros);
  }

  // Deducted after the fact, from the real cost of what was just used. The
  // check above admits on `available > 0` rather than `>= estimate`, so a
  // message can still push the balance slightly negative — that's the intended
  // prepaid-metering behaviour, and it corrects itself on the next top-up. What
  // the hold adds is a bound: the overdraft is at most one estimate no matter
  // how many requests arrive at once, where before it was unbounded.
  const usage = result.usage || {};
  const costMicros = priceMicros(usage);
  const newBalance = adjustBalance(claims.sub, -costMicros, backing);
  // estimate-vs-actual is how the reservation's overdraft bound gets verified
  // against production traffic; a persistent estimate < actual would mean the
  // hold no longer covers the worst case. The cache token fields are what
  // makes real cache hit rates observable from the logs.
  logEvent('llm_spend', {
    subject: claims.sub,
    estimateMicros,
    costMicros,
    inputTokens: usage.inputTokens || 0,
    outputTokens: usage.outputTokens || 0,
    cacheReadTokens: usage.cacheReadTokens || 0,
    cacheWriteTokens: usage.cacheWriteTokens || 0,
    balanceMicros: newBalance
  });

  return json(200, {
    text: result.text || '',
    toolCalls: result.toolCalls || [],
    balanceMicros: newBalance,
    balanceGbp: microsToGbp(newBalance),
    balanceCredits: microsToCredits(newBalance)
  });
}

// The cache token counts are ADDITIVE to inputTokens: Anthropic's
// input_tokens excludes cache_read_input_tokens and cache_creation_input_tokens,
// so the billable input is the sum of all three, each at its own rate. Models
// whose pricing entry has no cache rates fall back to the plain input rate.
function priceMicros({ inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0 } = {}) {
  const pricing = config.llm.pricing[config.llm.model] || config.llm.pricing.default;
  const costUsd = (
    inputTokens * pricing.inputPerMillionUsd
    + cacheReadTokens * (pricing.cacheReadPerMillionUsd ?? pricing.inputPerMillionUsd)
    + cacheWriteTokens * (pricing.cacheWritePerMillionUsd ?? pricing.inputPerMillionUsd)
    + outputTokens * pricing.outputPerMillionUsd
  ) / 1_000_000;
  return Math.ceil(costUsd * config.llm.usdToGbpRate * config.llm.marginMultiplier * 1_000_000);
}

// Worst case for the call about to be made, used only to size the hold. Output
// is bounded server-side by config.llm.maxTokens (the client cannot raise it),
// and input by the request caps above, so this is a real ceiling rather than a
// guess. ~4 chars per token is the usual rough ratio; erring high is safe here
// because the hold is released as soon as the call returns. All estimated
// input is priced at the cache-WRITE rate (1.25x the plain input rate): the
// most expensive real outcome is the whole prompt being written to cache, so
// this keeps the estimate a true ceiling over every cache mix.
function estimateCostMicros({ systemChars, messages, tools }) {
  const chars = systemChars
    + messages.reduce((sum, m) => sum + (m.content?.length || 0), 0)
    + JSON.stringify(tools || []).length;
  return priceMicros({ cacheWriteTokens: Math.ceil(chars / 4), outputTokens: config.llm.maxTokens });
}

// Tool schemas reach the provider verbatim as input_schema, so bound their
// depth and strip prototype-polluting keys before anything downstream walks
// or merges them. Returns INVALID_SCHEMA when the shape is unacceptable.
const INVALID_SCHEMA = Symbol('invalid schema');
const FORBIDDEN_SCHEMA_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function sanitizeToolSchema(node, depth = 0) {
  if (depth > MAX_TOOL_SCHEMA_DEPTH) return INVALID_SCHEMA;
  if (Array.isArray(node)) {
    const out = [];
    for (const item of node) {
      const clean = sanitizeToolSchema(item, depth + 1);
      if (clean === INVALID_SCHEMA) return INVALID_SCHEMA;
      out.push(clean);
    }
    return out;
  }
  if (node && typeof node === 'object') {
    const out = {};
    for (const key of Object.keys(node)) {
      if (FORBIDDEN_SCHEMA_KEYS.has(key)) continue;
      const clean = sanitizeToolSchema(node[key], depth + 1);
      if (clean === INVALID_SCHEMA) return INVALID_SCHEMA;
      out[key] = clean;
    }
    return out;
  }
  if (node === null || ['string', 'number', 'boolean'].includes(typeof node)) return node;
  return INVALID_SCHEMA; // functions/symbols can't appear in JSON bodies anyway
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

function rateLimited() {
  return json(429, { error: 'Too many requests. Slow down and try again shortly.', code: 'rate_limited' });
}
