import { config, findTopUp, creditMicrosForTopUp, microsToCredits, sandboxCreditCapMicros } from './config.js';
import { verifyAppleReceipt, verifyAppleJWS, decodeJWS, VerificationError } from './apple.js';
import { verifyGooglePurchase, consumePurchase } from './google.js';
import { signToken, verifyToken, subjectFor, safeEqualString, TokenError } from './tokens.js';
import {
  adjustBalance, getBalanceMicros, markCredited,
  getCreditRecord, refundTopUp, generateAccessCode, redeemAccessCode,
  hasBalanceRecord, generateRecoveryCode, lookupRecoveryCode, hasRecoveryCode,
  getTokenVersion, getSandboxCreditMicros, addSandboxCreditMicros, store
} from './store.js';
import { callCoachLLM, UpstreamError } from './llm.js';
import { reservations } from './reservations.js';
import { rateLimiter } from './ratelimit.js';
import { logEvent, newRequestId } from './log.js';

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
  // Unauthenticated by necessity — the whole point is that the caller has
  // nothing left but the account UUID — so this and the miss lockout below
  // are the only things standing in front of it.
  '/v1/entitlement/recover': { limit: 30, windowMs: HOUR },
  '/v1/webhooks/apple': { limit: 120, windowMs: MINUTE },
  '/v1/webhooks/google': { limit: 120, windowMs: MINUTE },
  // Reporting is deliberately reachable without a token (a user on their own
  // API key has none, and Play requires them to be able to report too), so the
  // IP limit is the only thing standing in front of it. Low, because reporting
  // is a rare human act — but not so low that a genuinely bad session can't be
  // reported several times over.
  '/v1/report': { limit: 20, windowMs: HOUR }
};

// Failed redemptions are tracked separately from volume: a miss means someone
// is guessing codes, and this bound is what makes the short human-typeable
// format safe against brute force (32^8 codes at 10 misses/hour/IP).
const REDEEM_FAILS = { limit: 10, windowMs: HOUR };

// The same shape for /v1/entitlement/recover, and for the same reason: a miss
// means someone is guessing account UUIDs. Ten an hour per IP is what keeps a
// 122-bit v4 UUID unguessable in practice rather than only in theory.
//
// The endpoint answers in three shapes, and only one of them is an oracle
// worth anything: 400 `bad_request` for a token that is not even the right
// shape (or a platform that does not exist), 404 `no_balance_for_account` for
// a well-formed id nobody has purchased under, and 200 for one that has. So a
// guesser learns "that was not a UUID" for free — which they already knew,
// having typed it — and every guess that *is* a plausible UUID gets the one
// undifferentiated 404, charged against the budget below.
const RECOVER_FAILS = { limit: 10, windowMs: HOUR };

// Per-subject limits, checked inside the endpoints once the token is known.
const CHAT_LIMIT = { limit: 30, windowMs: MINUTE };
const CODE_LIMIT = { limit: 10, windowMs: HOUR };
const RECOVERY_CODE_LIMIT = { limit: 10, windowMs: HOUR };

export async function handleRequest({ method, path, headers = {}, body = null, query = {}, ip = '' }, deps = {}) {
  const backing = deps.store || store;
  const limiter = deps.rateLimiter || rateLimiter;

  if (method === 'GET' && path === '/health') {
    return healthEndpoint(backing, limiter, ip);
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
      case '/v1/entitlement/verify': return await verifyEndpoint(body, headers, deps, backing);
      case '/v1/entitlement/refresh': return refreshEndpoint(body, backing);
      case '/v1/entitlement/code': return codeEndpoint(headers, backing, limiter);
      case '/v1/entitlement/redeem': return redeemEndpoint(body, backing, limiter, ip);
      case '/v1/entitlement/recover': return recoverEndpoint(body, backing, limiter, ip);
      case '/v1/entitlement/recovery-code': return recoveryCodeEndpoint(headers, body, backing, limiter);
      case '/v1/chat': return await chatEndpoint(headers, body, deps, backing, limiter);
      case '/v1/report': return reportEndpoint(headers, body, backing);
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

// ---- Health ---------------------------------------------------------------

// How often the probe is allowed to actually write. A FileStore mutation
// serialises the whole ledger and fsyncs it, so the write must not be on a
// path anyone can call at will: /health is unauthenticated and, unlike every
// other route, is answered before the IP limits below — so an unthrottled
// probe is disk write amplification that grows with every purchase ever made.
//
// Reads still happen on every request, which is what catches the failure this
// exists for on all but the first call after a volume goes: a store whose
// backing file vanished cannot answer the value it just wrote either.
const HEALTH_WRITE_INTERVAL_MS = 30_000;
const HEALTH_PROBE_KEY = 'health:probe';

// A ceiling on probe traffic regardless. Railway only calls this at deploy
// time; anything above this rate is not a deploy.
const HEALTH_LIMIT = { limit: 120, windowMs: MINUTE };

function healthEndpoint(backing, limiter, ip) {
  if (!limiter.check('ip:/health', ip || 'unknown', HEALTH_LIMIT.limit, HEALTH_LIMIT.windowMs)) {
    return rateLimited();
  }
  // Readiness, not liveness: a store round-trip, including a real write, so a
  // FileStore whose volume unmounted after boot fails here rather than at the
  // next purchase. Boot-time config problems already stop the process.
  try {
    const previous = Number(backing.get(HEALTH_PROBE_KEY) || 0);
    const now = Date.now();
    if (now - previous >= HEALTH_WRITE_INTERVAL_MS) {
      backing.set(HEALTH_PROBE_KEY, now, 10 * MINUTE);
      if (!(Number(backing.get(HEALTH_PROBE_KEY)) > 0)) throw new Error('probe read back empty');
    } else if (!(previous > 0)) {
      throw new Error('probe read back empty');
    }
    return json(200, { ok: true });
  } catch (e) {
    console.error('[intention] health probe failed', e);
    return json(503, { ok: false, code: 'store_unavailable' });
  }
}

// ---- Entitlement ----------------------------------------------------------

async function verifyEndpoint(body, headers, deps, backing) {
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

  // A promo code is redeemed in the App Store / Play Store, outside this app's
  // own purchase flow, so its transaction carries no account token to key a
  // balance by. For those — and only those — the client asserts the same
  // device-local UUID its real purchases are already keyed by, so a tester's
  // promo credit lands in the very same balance as anything they later buy.
  //
  // Strictly a fallback: whenever the store gave us a token that one wins, so
  // a tampered client can never re-point a real sale at a subject of its
  // choosing. The residual risk is narrow and deliberate — someone who already
  // knew another person's account UUID could direct a promo grant at their
  // balance, which adds credit rather than taking it.
  const storeToken = platform === 'apple' ? result.appAccountToken : result.obfuscatedExternalAccountId;
  const accountToken = storeToken || (result.isPromo ? assertedAccountToken(body?.accountToken) : '');
  if (!accountToken) {
    return json(400, {
      error: 'A redeemed code needs an account token to credit.',
      code: 'account_token_required'
    });
  }
  // ...with one relaxation, added for recovery. A device that recovered by
  // code holds a live token for subject A while its own freshly-minted local
  // UUID attests as B, so without this its next top-up credits B and the
  // credit it just paid for appears to vanish. So: a valid, current, unrevoked
  // bearer token for the *same platform* names the subject instead.
  //
  // What that trades away is "the store's word beats the client's, always".
  // What it does not trade away is anything that could take credit off
  // somebody: the override is additive-only, it can only ever name a subject
  // the caller already holds a live signed token for (which is exactly the
  // credential they would use to spend that balance anyway), and the
  // `credited:` record below is written against the overridden subject, so a
  // later refund claws back from the balance the money actually landed in.
  const attested = bearerSubjectFor(headers, platform, backing) || subjectFor(platform, accountToken);
  // ...and creditTopUp, not this line, has the last word on which subject the
  // response is for. The override above only works while the client is still
  // holding a live bearer, and the path it exists for is precisely the one
  // where it is not: tokens age out at tokenMaxLifetimeMs, refreshEntitlement
  // then falls back to re-verifying the stored receipt, and that fallback
  // sends no Authorization header. Every recovered user would eventually land
  // back on their device-attested subject, see a zero balance, and strand the
  // credit they paid for.
  //
  // So the *credit record* is the authority, exactly as it is for the refund
  // clawback below: for a transaction that was already credited, the response
  // names the subject the money actually went to. That needs no bearer and no
  // client change, and it cannot be turned into a way of reading a stranger's
  // balance that a receipt is not already — an ordinary receipt carries the
  // buyer's own appAccountToken, so possessing it already resolves to their
  // subject on the line above.
  const subject = await creditTopUp(platform, attested, result, backing, deps);
  return json(200, entitlementResponse(subject, platform, result.productId, backing, { src: 'store' }));
}

// A bearer on /v1/entitlement/verify is optional and advisory, so every way of
// being invalid — forged, expired, revoked, for the other store — silently
// yields nothing and lets the store-attested subject stand. Throwing here
// would turn a stale token on a device that is otherwise mid-purchase into a
// 401 on a purchase the store already took the money for.
function bearerSubjectFor(headers, platform, backing) {
  const raw = bearer(headers);
  if (!raw) return '';
  try {
    const claims = assertTokenCurrent(verifyToken(raw, config.tokenSecret), backing);
    return claims.platform === platform ? claims.sub : '';
  } catch (e) {
    return '';
  }
}

// Both clients key a balance by a UUID they generate once and keep (Keychain
// on Apple, SharedPreferences on Android). Shape-checked and bounded rather
// than taken as-is, so the subject hash can never be fed an oversized or
// structured value by a client that made one up.
const ACCOUNT_TOKEN_RE = /^[A-Za-z0-9-]{8,64}$/;

function assertedAccountToken(value) {
  const token = String(value || '').trim();
  return ACCOUNT_TOKEN_RE.test(token) ? token : '';
}

// A refresh only proves the token is still valid and reports the current
// balance — it never re-grants credit. Granting only ever happens once, at
// verify time, guarded by the idempotency key in creditTopUp.
function refreshEndpoint(body, backing) {
  const claims = assertTokenCurrent(verifyToken(body?.token, config.tokenSecret), backing);
  // src rides along unchanged: a refresh proves the token is still live, not
  // that the session behind it got any stronger. A token minted before src
  // existed keeps carrying nothing, and stays on the fail-closed side of
  // recoveryCodeEndpoint until the device re-posts its stored receipt to
  // /v1/entitlement/verify — which is a thing the client now does, on that
  // endpoint's own 403, rather than something waited on. See RECOVERY_CODE_SRC.
  return json(200, entitlementResponse(claims.sub, claims.platform, claims.productId, backing,
    { src: claims.src, priorClaims: claims }));
}

// Credits a top-up exactly once per store purchase (keyed by the
// transaction/order id, never combined with subject — the same account tops
// up repeatedly, but each individual purchase is creditable only once).
//
// Returns the subject the money is on: the caller's, when this call is what
// credited it, and otherwise the one named on the existing credit record.
// Those differ whenever the bearer override redirected the original credit,
// and the record is the one that knows — see the note in verifyEndpoint.
async function creditTopUp(platform, subject, result, backing, deps = {}) {
  const existing = getCreditRecord(platform, result.creditId, backing);
  const owner = (existing && existing.subject) || subject;
  if (!existing) {
    const topUp = findTopUp(platform, result.productId);
    const faceMicros = topUp ? creditMicrosForTopUp(platform, topUp.priceGbp) : 0;

    // A sandbox purchase is genuine — Apple signed it, the bundle matches, the
    // transaction id dedupes — but it moved no money and can be repeated for
    // free, so it credits only up to a lifetime ceiling per subject. Beyond
    // that it still verifies and still reports success, which is what keeps
    // App Review's own repeat purchases from looking broken; it just adds
    // nothing. Production purchases never touch any of this.
    const sandbox = result.environment === 'sandbox';
    let creditMicros = faceMicros;
    if (sandbox) {
      const headroom = Math.max(0, sandboxCreditCapMicros(platform) - getSandboxCreditMicros(subject, backing));
      creditMicros = Math.min(faceMicros, headroom);
    }

    const record = {
      subject,
      productId: result.productId,
      creditMicros,
      creditedAt: Date.now(),
      refunded: false,
      creditId: result.creditId,
      purchaseToken: result.purchaseToken || null,
      orderId: result.creditId,
      // Kept on the record so a refund clawback deducts what was actually
      // credited, and so a capped purchase is legible in an audit rather than
      // looking like a pricing bug.
      ...(sandbox ? { environment: 'sandbox', faceMicros } : {})
    };
    markCredited(platform, result.creditId, record, backing);
    if (result.purchaseToken && result.purchaseToken !== result.creditId) {
      markCredited(platform, result.purchaseToken, record, backing);
    }
    if (creditMicros > 0) {
      if (sandbox) addSandboxCreditMicros(subject, creditMicros, backing);
      adjustBalance(subject, creditMicros, backing);
    }
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
  return owner;
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
      // The credit record first, the notification's own token second — the
      // same order the Play webhook below uses, and for a stronger reason
      // than symmetry. verifyEndpoint lets a live bearer redirect a credit
      // away from the store-attested account (the recovery case), so on a
      // refund the token Apple echoes back names the *device*, not the
      // balance the money landed in. Deducting from it would leave the
      // refunded user their credit and mint a phantom negative balance under
      // a subject that never bought anything — which /v1/entitlement/recover
      // would then happily hand to whoever holds that device's UUID, silently
      // eating their next top-up.
      const existing = getCreditRecord('apple', transactionId, backing);
      const subject = existing?.subject
        || (appAccountToken ? subjectFor('apple', appAccountToken) : null);
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

// How the caller of this response proved they were entitled to it. It is
// stamped into the token so a later route can tell the strength of the
// session in front of it apart, which `sub` alone cannot say:
//
//   'store'   — verified a store receipt (the paying device)
//   'link'    — redeemed a 15-minute, single-use browser access code
//   'paper'   — redeemed a long-lived recovery code
//   'account' — /v1/entitlement/recover, on a surviving account UUID alone
//
// Required rather than defaulted, and read out of an options object rather
// than a fifth positional, because the one consumer (recoveryCodeEndpoint)
// fails *closed* on anything it does not recognise. A new mint site that
// forgets to name itself therefore mints a weaker token, not a stronger one.
function entitlementResponse(subject, platform, productId, backing, { src, priorClaims = null } = {}) {
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
    src,
    tv: getTokenVersion(subject, backing),
    exp
  };
  return {
    active: balanceMicros > 0,
    productId: productId || '',
    balanceMicros,
    balanceGbp: microsToGbp(balanceMicros),
    balanceCredits: microsToCredits(balanceMicros),
    // Echoed in the body as well as sealed in the token, because the client
    // has to know the strength of the session it is holding *before* it offers
    // an action only some sessions may take. Without it a browser that redeemed
    // a link code was shown a "Recovery code" button that could only ever come
    // back 403 — an offered button that always fails being worse than none. It
    // discloses nothing the caller does not already possess: it is a claim in
    // the token in their hand.
    src,
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
  // One endpoint, two kinds of code: the 15-minute single-use link code above,
  // then the long-lived multi-use recovery code. Both are typed into the same
  // box by someone who has no idea there is a difference, and the volume and
  // miss limits already in front of this route cover both.
  const link = redeemAccessCode(body?.code, backing);
  const claims = link || lookupRecoveryCode(body?.code, backing);
  // A code is a credential that outlives the token it was minted from, so it
  // has to answer to bumpTokenVersion too. Redemption goes through
  // entitlementResponse, which *re-reads* the current version to stamp the
  // token it issues — so without this check a revoked subject's recovery code
  // would keep minting fresh, current tokens for ever, and the one revocation
  // lever the server has would be dead on the longest-lived credential it
  // hands out. The version at mint time is captured on the code record
  // (store.js); a record from before that field existed carries 0, which is
  // also what an unrevoked subject reads, so nothing pre-existing breaks.
  const revoked = claims && Number(claims.tv || 0) !== getTokenVersion(claims.sub, backing);
  if (!claims || revoked) {
    limiter.record('redeem-fail', ip || 'unknown', REDEEM_FAILS.windowMs);
    // Deliberately the same body either way: which of "no such code",
    // "already spent" and "revoked" it was is not something a guesser gets
    // to learn.
    return json(404, { error: 'That code is not valid or has already been used.', code: 'entitlement_invalid' });
  }
  return json(200, entitlementResponse(claims.sub, claims.platform, claims.productId, backing,
    { src: link ? 'link' : 'paper' }));
}

// Turning a surviving account id back into a live entitlement.
//
// Everything else on this file wants proof of purchase, and after a reinstall
// there is none left to give: the top-up is a consumable, so its receipt was
// consumed at purchase, Play's INAPP query no longer returns it, and Apple's
// currentEntitlements excludes consumables by design. AppTransaction would
// prove the app was legitimately obtained, not that this person owns this
// balance — security theatre with a macOS and Android parity cost. So the
// account id is the credential, and the rate limits above are the control.
//
// It writes nothing, on either path. That is structural rather than a rule
// somebody has to remember: a hit only reads a balance and signs a token, and
// a miss only touches the in-memory rate limiter. It matters twice over —
// creating a zero balance on a miss would make every future guess of that same
// UUID succeed, and FileStore.set() serialises and fsyncs the entire ledger,
// so a writeable unauthenticated route is disk-write amplification.
function recoverEndpoint(body, backing, limiter, ip) {
  if (limiter.atLimit('recover-fail', ip || 'unknown', RECOVER_FAILS.limit)) {
    return rateLimited();
  }
  const platform = body?.platform;
  if (platform !== 'apple' && platform !== 'google') {
    return json(400, { error: `Unknown platform: ${platform}`, code: 'bad_request' });
  }
  const asserted = assertedAccountToken(body?.accountToken);
  if (!asserted) {
    return json(400, { error: 'accountToken is required', code: 'bad_request' });
  }

  for (const candidate of accountTokenCandidates(asserted)) {
    const subject = subjectFor(platform, candidate);
    if (hasBalanceRecord(subject, backing)) {
      logEvent('entitlement_recover', { subject, platform });
      return json(200, entitlementResponse(subject, platform, '', backing, { src: 'account' }));
    }
  }

  limiter.record('recover-fail', ip || 'unknown', RECOVER_FAILS.windowMs);
  return json(404, {
    error: 'No coaching credit is attached to this device.',
    code: 'no_balance_for_account'
  });
}

// subjectFor hashes the account token verbatim, and nothing normalises its
// case anywhere in the pipeline: Swift renders a UUID uppercase, Apple echoes
// appAccountToken back in whatever case it feels like, and a balance is keyed
// by whichever of those arrived first. Trying all three here is a read-only
// widening that costs two extra hash lookups; normalising subjectFor itself
// would re-key — and so orphan — every balance that already exists.
function accountTokenCandidates(token) {
  return [...new Set([token, token.toLowerCase(), token.toUpperCase()])];
}

// Which kinds of session may mint or rotate the paper artefact.
//
// A live bearer is not enough, because a bearer is exactly what
// /v1/entitlement/redeem hands to whoever types a browser access code — and
// that code's whole documented guarantee is that it is single use, so one
// shared or shoulder-surfed after the fact is already spent. Letting the
// session behind it mint a recovery code would turn a fifteen-minute,
// one-shot link into a permanent, multi-use credential, and `{rotate:true}`
// would let its holder silently 404 the code the owner has written down.
//
// So: 'store', the paying device, which can still prove purchase to Apple or
// Google and is where the recovery code belongs. And 'paper', a session that
// redeemed a recovery code — it already holds the strongest artefact there
// is, so re-showing or rotating it escalates nothing. 'link' and 'account'
// are refused, and so is a token minted before `src` existed.
//
// That last case is every device that was already paying when this shipped,
// which is most of them, so it needs a way out and this comment used to claim
// one it did not have: nothing re-verifies a store receipt on launch. A
// consumable is finished at purchase, so it never comes back through
// Transaction.unfinished or Play's INAPP query to be re-checked, and a refresh
// carries the missing claim forward unchanged — the legacy session would have
// stood until the token's 365-day absolute lifetime ran out.
//
// The way out is now explicit and client-side: on this 403 the client re-posts
// its STORED receipt to /v1/entitlement/verify, which mints a properly stamped
// 'store' token, and retries once (requestRecoveryCode in billing.js). One
// settings open, not a year. A browser that redeemed a link code holds no
// receipt and so is never upgraded, which is the intent — it is told where its
// recovery code actually lives instead of being offered a button that 403s.
const RECOVERY_CODE_SRC = new Set(['store', 'paper']);

// The paper artefact: minted from inside the app while the entitlement is
// still live, so that when the device is gone the user has something to type.
// Idempotent, so re-opening Settings shows the same code rather than issuing
// a second key to the same balance.
function recoveryCodeEndpoint(headers, body, backing, limiter) {
  const claims = assertTokenCurrent(verifyToken(bearer(headers), config.tokenSecret), backing);
  if (!RECOVERY_CODE_SRC.has(claims.src)) {
    return json(403, {
      error: 'A recovery code can only be created on the device that bought the credit.',
      code: 'store_session_required'
    });
  }
  const rotate = body?.rotate === true;
  // Charge the throttle to minting only. Opening Settings is an idempotent
  // read — that is the entire reason the same code comes back every time —
  // and charging it meant the eleventh visit in an hour answered 429 and no
  // recovery code, on the screen whose only job is to show one.
  const minting = rotate || !hasRecoveryCode(claims.sub, backing);
  if (minting && !limiter.check('recovery-code', claims.sub, RECOVERY_CODE_LIMIT.limit, RECOVERY_CODE_LIMIT.windowMs)) {
    return rateLimited();
  }
  const issued = generateRecoveryCode({
    sub: claims.sub,
    platform: claims.platform,
    productId: claims.productId
  }, { backing, rotate });
  return json(200, issued);
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

// ---- Reports --------------------------------------------------------------

const MAX_REPORT_CHARS = 4_000;
const MAX_REPORT_NOTE_CHARS = 1_000;
// Long enough to spot a pattern across weeks of reports, short enough that this
// isn't an open-ended archive of things people found upsetting.
const REPORT_TTL_MS = 180 * 24 * HOUR;

// A user reporting something the coach said. Play's AI-Generated Content policy
// requires the affordance and requires that reports "inform content filtering
// and moderation" — which they can't do if they land somewhere unreadable, so
// this both persists the report and emits it as a log event.
//
// That log line is the one deliberate exception to log.js's rule against
// logging message content. It is narrow and it is consented: the client says in
// plain words, on the sheet, exactly what it is about to send, and nothing
// reaches here that a user did not choose to send.
//
// Unauthenticated by design — see the IP_LIMITS note. A token is used when one
// is presented, purely so a repeat reporter can be recognised across reports,
// and a bad token is ignored rather than rejected: losing the report would be
// worse than losing the attribution.
function reportEndpoint(headers, body, backing) {
  const reported = clampReportText(body && body.reported, MAX_REPORT_CHARS);
  if (!reported) {
    return json(400, { error: 'Nothing to report', code: 'invalid_request' });
  }

  let subject = '';
  const token = bearer(headers);
  if (token) {
    try {
      subject = verifyToken(token, config.tokenSecret).sub || '';
    } catch (e) {
      subject = '';
    }
  }

  const record = {
    reported,
    prompt: clampReportText(body && body.prompt, MAX_REPORT_CHARS),
    note: clampReportText(body && body.note, MAX_REPORT_NOTE_CHARS),
    provider: clampReportText(body && body.provider, 64),
    model: clampReportText(body && body.model, 128),
    subject,
    at: new Date().toISOString()
  };

  const id = newRequestId();
  try {
    backing.set(`report:${id}`, record, REPORT_TTL_MS);
  } catch (e) {
    // A full or unmounted volume must not swallow the report — the log line
    // below is what actually gets read, so carry on and let it through.
    console.error('[intention] report store write failed', e);
  }
  logEvent('coach_report', { id, ...record });

  // 200 rather than 204: index.js writes a JSON body for every reply, and a
  // 204 carrying one is a protocol violation waiting to confuse a proxy.
  return json(200, { ok: true });
}

function clampReportText(value, max) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
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
