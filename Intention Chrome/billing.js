// ---------------------------------------------------------------------------
// Hosted AI access: in-app purchases, entitlement bookkeeping, paywall UI.
// ---------------------------------------------------------------------------
//
// Intention's coach runs on Intention's own backend, which holds the LLM
// provider key. Access to it is sold through the platform's own in-app
// purchase system — StoreKit on Apple, Play Billing on Android — surfaced to
// this layer as `window.intentionBilling` by ios-bridge.js / android-bridge.js.
// That bridge is the ONLY way anything is bought here: no checkout page, no
// outside link, no key to fetch from a third party.
//
// This file is page-side only (options.html, coaching.html). The background
// worker needs just the entitlement predicate and the hosted transport, which
// live in providers.js so the worker doesn't have to load a UI module.

// How the AI plan can be bought or managed *on this build*:
//
//   'store'   — a native store bridge is present (the iOS/macOS app, the
//               Android app). Apple IAP / Google Play Billing, and nothing
//               else, may be offered.
//   'managed' — an Apple platform with no bridge: the Safari web extension's
//               own pages, which ship inside the same App Store app. Access is
//               bought in the app and syncs across; never show a key field or
//               an outside link here either.
//   'byok'    — Chrome / Firefox. There is no store to buy through in a
//               browser extension, so a user-supplied provider key stays a
//               first-class, visible option on these builds.
//
// The Apple half of this is IS_APPLE_BUILD (providers.js), which both the
// 'store' and 'managed' cases fall under and which the background worker
// shares — a mode computed here would be page-side only.
function detectBillingMode() {
  if (typeof window !== 'undefined' && window.intentionBilling) return 'store';
  return IS_APPLE_BUILD ? 'managed' : 'byok';
}

const BILLING_MODE = detectBillingMode();

// Whether a user-supplied provider key may be offered as a starting option —
// the first thing a new user is asked to do. Nowhere a store reviews the build
// may it be that, so on 'store'/'managed' the purchase route leads. Where a key
// may exist at all it then lives in Settings -> Advanced; on Apple that section
// isn't rendered and the route isn't honoured (see below).
const STORE_MODES = ['store', 'managed'];
const BYOK_IS_PRIMARY = !STORE_MODES.includes(BILLING_MODE);

// Whether the key may be *offered at all* from the paywall, as a secondary
// route beneath the purchase buttons. This is a weaker thing than being
// primary, and the two stores differ on it:
//
//   Apple  — no, and stronger than no. 3.1.1 reads unlocking app functionality
//            against anything bought outside IAP, and a key bought on a
//            provider's website is exactly that: Apple rejected the build that
//            merely left it unadvertised in Settings -> Advanced. So on Apple
//            the field is absent and resolveAIRoute() ignores a stored key —
//            this flag governs the paywall, not whether BYOK exists.
//   Google — yes. Play's Payments policy governs digital goods *you* sell; a
//            key the user already holds with Anthropic or Groq was never a
//            purchase from us, so it never engages. Hiding it there was only
//            ever collateral from sharing this flag with Apple.
//
// BILLING_MODE stays 'store' on Android either way: Play Billing is still how
// coaching credit is bought, and this changes nothing about that.
const IS_ANDROID_STORE = BILLING_MODE === 'store'
  && /Android/.test((typeof navigator !== 'undefined' && navigator.userAgent) || '');
const BYOK_IS_OFFERED = BYOK_IS_PRIMARY || IS_ANDROID_STORE;

// How long a question put to the native bridge may go unanswered before we
// treat it as unanswerable.
//
// Every bridge call resolves on a callback, and a callback is a promise that
// can simply never settle: an older WebView with no handler for the action, a
// native side that threw before invoking it, a Play Billing connection that
// died mid-flight. A promise that never settles is not a slow paywall, it is a
// permanently empty one — whatever awaited it never runs, and nothing renders
// and nothing is logged.
//
// Opt-in rather than universal, because the two things this bridge does divide
// cleanly. `purchase` and `redeem` hand off to the store's own sheet and are
// waiting on a human, so they may legitimately take minutes and must not be
// cut off. The question-shaped calls below — the account id, the product list,
// the status — answer in milliseconds or never.
const BRIDGE_QUERY_TIMEOUT_MS = 8000;

function sendBilling(method, arg, { timeoutMs = 0 } = {}) {
  return new Promise(resolve => {
    if (!window.intentionBilling || typeof window.intentionBilling[method] !== 'function') {
      resolve({ available: false });
      return;
    }
    // A missed deadline resolves to the same { available: false } shape that
    // "there is no bridge at all" already resolves to, so every reader here
    // handles it without a second code path. Settling is latched because the
    // bridge is native code we do not control: answering twice, or answering
    // after the deadline, must not resurrect anything.
    let settled = false;
    let timer = null;
    const answer = (result) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve(result);
    };
    if (timeoutMs > 0) {
      timer = setTimeout(() => answer({ available: false, error: 'The store did not respond.' }), timeoutMs);
    }
    if (arg === undefined) window.intentionBilling[method](answer);
    else window.intentionBilling[method](arg, answer);
  });
}

// ---- Store bridge ----------------------------------------------------------

// Resolves { available, products: [{ id, title, description, price, period,
// type }] }. `price` is already localized and formatted by the store.
function fetchStoreProducts() {
  return sendBilling('products', undefined, { timeoutMs: BRIDGE_QUERY_TIMEOUT_MS });
}

// Resolves { status: 'purchased' | 'cancelled' | 'pending' | 'failed',
// receipt?, error? }. `receipt` is whatever the backend needs to verify with
// the store: Apple's signed transaction (JWS), or Play's purchase token.
function purchaseProduct(productId) {
  return sendBilling('purchase', productId);
}

function restorePurchases() {
  return sendBilling('restore');
}

// Opens the platform's own code-redemption sheet — App Store promo codes via
// SKPaymentQueue on iOS, Play's redeem screen on Android — and resolves the
// same shape a purchase does once the granted transaction has been picked up.
// Nothing about this leaves the store's own flow: there is no code field of
// ours, and no way to redeem anything here that the store didn't issue.
function redeemStoreCode() {
  return sendBilling('redeem');
}

// The device-local UUID a balance is keyed by. A redeemed code carries no
// account token of its own (it never went through our purchase flow), so this
// is what gives the grant a balance to land in.
async function storeAccountToken() {
  const result = await sendBilling('accountToken', undefined, { timeoutMs: BRIDGE_QUERY_TIMEOUT_MS });
  return (result && result.token) || '';
}

// Whether the account token above was PUT BACK by the platform rather than
// minted here. Android answers it (Auto Backup restores intention_billing.xml,
// and the minted-at stamp rides along, so a stamp older than this install means
// something restored it); Apple's Keychain item is synchronizable and the app
// has no equivalent question to ask, so the bridge simply omits the field.
//
// `undefined` therefore means "this build cannot tell", and every caller must
// treat that as "say nothing" rather than as `false` — the fresh-install notice
// it drives would otherwise appear on Apple, where it is not true.
async function storeAccountRestored() {
  const result = await sendBilling('accountToken', undefined, { timeoutMs: BRIDGE_QUERY_TIMEOUT_MS });
  return result && typeof result.restored === 'boolean' ? result.restored : undefined;
}

function storeEntitlementStatus() {
  return sendBilling('status', undefined, { timeoutMs: BRIDGE_QUERY_TIMEOUT_MS });
}

// ---- Backend verification --------------------------------------------------

async function postBackend(backendUrl, path, body, token) {
  const base = (backendUrl || DEFAULT_INTENTION_BACKEND_URL).replace(/\/+$/, '');
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) {
    const err = new Error((data && data.error) || `Backend ${res.status}`);
    err.code = (data && data.code) || 'backend_error';
    throw err;
  }
  return data || {};
}

// The bearer-authenticated half, named rather than left as a fourth positional
// argument at each call site. Two endpoints need it — minting a browser link
// code and minting a recovery code — and they had one hand-rolled fetch
// between them, which is how the older of the two ended up dropping the
// backend's `code` on the floor and reporting every refusal as a bare message.
// Both now surface `err.code`, and two callers read it. requestRecoveryCode
// below tells `store_session_required` from a network hiccup and re-verifies
// its stored receipt on the first, because a device that bought the credit
// before the server stamped sessions holds a token that cannot say so. And
// buildRecoveryBlock reads it again to pick its message, because "try again in
// a moment" is a lie about a refusal that will never change its mind.
function postBackendAuthed(backendUrl, path, token, body) {
  return postBackend(backendUrl, path, body || {}, token);
}

// Hands the store's proof-of-purchase to Intention's backend, which checks it
// with Apple/Google and mints the access token the coach calls are made with.
// Returns the entitlement to persist.
async function verifyPurchase({ platform, receipt, backendUrl }) {
  const data = await postBackend(backendUrl, '/v1/entitlement/verify',
    await verifyRequestBody(platform, receipt));
  return normalizeEntitlement({ ...data, source: platform, receipt });
}

// Sent on every store verify, not just redemptions: it costs nothing when the
// transaction carries its own account token (the backend prefers that one and
// ignores this), and it is the only thing that makes a redeemed code
// creditable. Browser builds have no bridge to ask, so they send nothing.
async function verifyRequestBody(platform, receipt) {
  const body = { platform, receipt };
  if (BILLING_MODE !== 'store') return body;
  try {
    const accountToken = await storeAccountToken();
    if (accountToken) body.accountToken = accountToken;
  } catch (e) {
    // An older bridge has no accountToken action. A normal purchase verifies
    // fine without it; only a redemption needs it, and that will surface as
    // the backend's own account_token_required rather than as a crash here.
  }
  return body;
}

// Whether this entitlement still carries proof we can put back to the store.
// A consumable's receipt is finished at purchase as far as the STORE is
// concerned, but our backend re-checks it and re-mints from it happily, so the
// stored copy stays the durable proof. `source === 'code'` is the exclusion
// that matters: a redeemed code leaves no receipt of its own, and its `receipt`
// field is null anyway.
function hasReverifiableReceipt(entitlement) {
  return !!(entitlement && entitlement.receipt && entitlement.source && entitlement.source !== 'code');
}

// Which resolved AI routes may ask the backend about a stranded balance.
//
// The guard used to be on the BUILD (`BILLING_MODE === 'store'`), and that is
// not the same question. BILLING_MODE stays 'store' on Android, where a custom
// key is also offered (IS_ANDROID_STORE above) — so a user who pasted their own
// Anthropic key and never bought anything was still having a stable device UUID
// posted, unauthenticated, to /v1/entitlement/recover every 24 hours for the
// life of the install. Nothing about that user's coaching touches our backend,
// and PRIVACY.md says so.
//
// 'hosted' is a balance we are already spending and 'locked' is one we may be
// missing; both have a reason to ask. 'byok' has none. An unrecognised or
// absent route asks nothing either — a new call site that forgets to say which
// route it is on makes no request rather than a silent one.
const RECOVERY_ROUTES = ['hosted', 'locked'];

// Re-checks a stored entitlement's live balance. Falls back to the entitlement
// we already hold if the backend can't be reached, so a flaky connection never
// locks a paying user out mid-flight — including on the last-resort account-id
// question below, which is opportunistic and whose failure is not news the
// caller can act on. Nothing in here throws for a network reason.
//
// `route` is the resolved AI route (see RECOVERY_ROUTES) and only governs that
// last resort; the token and receipt paths carry their own proof and are the
// caller's own business either way.
async function refreshEntitlement(entitlement, backendUrl, { route = null } = {}) {
  if (!entitlement || (!entitlement.token && !entitlement.receipt)) return entitlement || null;
  try {
    const data = entitlement.token
      ? await postBackend(backendUrl, '/v1/entitlement/refresh', { token: entitlement.token })
      : await postBackend(backendUrl, '/v1/entitlement/verify',
          await verifyRequestBody(entitlement.source, entitlement.receipt));
    return normalizeEntitlement({ ...data, source: entitlement.source, receipt: entitlement.receipt });
  } catch (e) {
    // A rejected token is not necessarily a dead entitlement: tokens now age
    // out at an absolute lifetime, and the stored receipt is the durable
    // proof. Re-verify from it before declaring the entitlement dead.
    if (e.code === 'entitlement_invalid' || e.code === 'entitlement_expired') {
      if (hasReverifiableReceipt(entitlement)) {
        try {
          const data = await postBackend(backendUrl, '/v1/entitlement/verify',
            await verifyRequestBody(entitlement.source, entitlement.receipt));
          return normalizeEntitlement({ ...data, source: entitlement.source, receipt: entitlement.receipt });
        } catch (e2) {
          // fall through: the receipt itself no longer verifies either
        }
      }
      // Last resort, and the reason a 365-day-old token is not a dead end: the
      // account id itself outlives both the token and the receipt (Apple's
      // Keychain, Android's Auto Backup), so ask the backend whether a balance
      // is still attached to it. Funnelling recovery through here rather than
      // sprinkling it across the callers is deliberate — every path that can
      // discover a dead entitlement already comes through this branch.
      let recovered = null;
      try {
        recovered = await attemptSilentRecovery(backendUrl, { route });
      } catch (e3) {
        // Opportunistic to the last. This is the third thing we have tried and
        // the only one with no proof attached; a failure to ask it says
        // nothing about the entitlement, so it must not become a throw out of
        // a function whose whole contract is that it does not throw.
      }
      if (recovered) return recovered;
      return { ...entitlement, active: false, pendingVerification: false, lastError: e.code };
    }
    return { ...entitlement, pendingVerification: true, lastError: String(e.message || e) };
  }
}

// "I still hold the account id, is there a balance behind it?" — the whole
// answer to a reinstall, and the only backend route with no proof on it at all.
// There is none left to give: a top-up is a consumable, so its receipt is
// finished at purchase, Play's INAPP query stops returning it and Apple's
// currentEntitlements excludes it by design. The server answers 404
// `no_balance_for_account` for an id it has never credited and writes nothing
// on either path, which is what stops a miss from conjuring an empty balance
// that every later guess of the same id would then find.
async function recoverEntitlement({ platform, accountToken, backendUrl }) {
  const data = await postBackend(backendUrl, '/v1/entitlement/recover', { platform, accountToken });
  return normalizeEntitlement({ ...data, source: platform, recoveryCheckedAt: Date.now() });
}

// The first-run form of the above: on a build with a store bridge, ask the
// bridge for the surviving account id and try it once.
//
// Four properties this has to keep, each of them a bug that was easy to write:
//
//   * On a browser build it makes NO network call whatsoever. There is no
//     bridge, so there is no account id to send, and the server cannot tell a
//     browser from anything else — the guard has to be here.
//   * On the 'byok' route it makes no network call either, on any build. See
//     RECOVERY_ROUTES: the build is not the route, and a user running the coach
//     on their own provider key was promised that we hear nothing about them.
//     `userAsked` is the exception, and it is the only one: the route guard is
//     about requests nobody asked for, and a press of "Restore credit from a
//     previous install" is somebody asking. Refusing that would make the button
//     a decoration for the one person on a custom key who does have credit
//     stranded somewhere.
//   * A 404 is silence, not an error. The overwhelmingly common caller is a
//     brand-new user who has never bought anything, and telling them their
//     credit could not be recovered would be both alarming and false.
//   * Anything else rethrows, and every caller is therefore responsible for
//     catching it. A 500 or a dead connection means "unknown", and swallowing
//     it *here* would turn a temporary outage into "your credit is gone" — but
//     letting it escape a caller that only asked out of opportunism is how a
//     whole settings page once died on an offline device.
async function attemptSilentRecovery(backendUrl, { route = null, userAsked = false } = {}) {
  if (BILLING_MODE !== 'store') return null;
  if (!userAsked && !RECOVERY_ROUTES.includes(route)) return null;
  const accountToken = await storeAccountToken();
  if (!accountToken) return null;
  try {
    return await recoverEntitlement({
      platform: IS_ANDROID_STORE ? 'google' : 'apple',
      accountToken,
      backendUrl
    });
  } catch (e) {
    if (e.code === 'no_balance_for_account') return null;
    throw e;
  }
}

// The paper artefact. Minted while the entitlement is still live so that when
// the device is gone there is something to type — which is why the settings
// page shows it BEFORE anything has been lost, rather than offering it as a
// remedy to someone who no longer has a session to mint one with.
//
// Idempotent: the same code comes back every time, so re-opening settings does
// not scatter live secrets. `rotate` replaces it and kills the old one.
//
// The retry is the whole of what makes this work for anyone who was already
// paying. The server only mints for a session that says how it proved itself
// (`src`, see RECOVERY_CODE_SRC in server/src/app.js), and every token minted
// before that claim existed says nothing — so every existing paying device,
// which is most of them, got a flat 403 that a refresh would carry forward for
// a year. It still holds the one thing that can fix that: the store receipt.
// Re-verifying it mints a freshly stamped 'store' token, and the second attempt
// goes through. One run, not a year, and this is the only path that upgrades a
// legacy session — nothing else re-mints, because a consumable never comes back
// through Transaction.unfinished to be re-verified on launch.
//
// `onUpgrade` is how the caller keeps the upgraded session: without persisting
// it, the next settings open re-verifies all over again.
async function requestRecoveryCode(entitlement, backendUrl, { rotate = false, onUpgrade = null } = {}) {
  if (!entitlement || !entitlement.token) throw new Error('No coaching credit on this device yet.');
  try {
    return await postBackendAuthed(backendUrl, '/v1/entitlement/recovery-code', entitlement.token, { rotate });
  } catch (e) {
    // Only this one refusal is worth a second attempt, and only where there is
    // something stronger to attempt it with. Everything else — a network
    // failure, a revoked token, a rate limit — is reported as it stands.
    if (e.code !== 'store_session_required' || !hasReverifiableReceipt(entitlement)) throw e;
    const upgraded = await verifyPurchase({
      platform: entitlement.source,
      receipt: entitlement.receipt,
      backendUrl
    });
    if (!upgraded || !upgraded.token) throw e;
    if (onUpgrade) await onUpgrade(upgraded);
    return postBackendAuthed(backendUrl, '/v1/entitlement/recovery-code', upgraded.token, { rotate });
  }
}

// Whether the recovery-code block may be OFFERED for this entitlement at all.
//
// The server refuses to mint for a session that redeemed a 15-minute browser
// link code, and it is right to: that code's whole guarantee is that it is
// single use, so letting the session behind it mint a permanent multi-use
// credential — and rotate away the code its owner has on paper — would undo
// the guarantee after the fact. But a button that always fails is worse than no
// button, and that is what a browser linked from a phone used to get: the block
// renders expanded on 'byok', so it fetched on sight and printed "try again in
// a moment" for ever.
//
// So the honest answer is shown instead (see renderPaywall): a browser's credit
// belongs to the phone that bought it, and so does the recovery code.
//
// A stored entitlement from before the server stamped `src` says nothing at
// all, and the receipt is what tells the two cases behind that silence apart: a
// paying device kept one and requestRecoveryCode above can upgrade it in a
// single run, a linked browser never had one.
const RECOVERY_CODE_SESSIONS = ['store', 'paper'];

function canMintRecoveryCode(entitlement) {
  if (!entitlement || !entitlement.token) return false;
  // A stored receipt answers first, and answers for every session kind: it can
  // always be turned back into a 'store' session, which is exactly what
  // requestRecoveryCode does on the refusal. That covers the device whose token
  // predates the claim, and the one that recovered from its account id and then
  // bought again — both hold a receipt, and neither should be told no.
  if (hasReverifiableReceipt(entitlement)) return true;
  if (entitlement.src) return RECOVERY_CODE_SESSIONS.includes(entitlement.src);
  return false;
}

// Browser builds have no store to buy through. An access code, generated in
// the mobile app for an existing balance, links this browser to the same
// account — no payment happens here. The same box now also takes a written-
// down recovery code; the server tells the two apart, so nothing here has to.
//
// Upper-cased on the way out, not just trimmed. Both code kinds are drawn from
// an alphabet that has no lower case in it, and a recovery code is copied off
// paper by someone who has just lost a device — the one moment where typing it
// in lower case is likeliest and being told "that code isn't valid" is worst.
// The server normalises too; doing it here as well costs nothing and means the
// client never sends something it already knows will miss.
async function redeemAccessCode(code, backendUrl) {
  const data = await postBackend(backendUrl, '/v1/entitlement/redeem',
    { code: String(code || '').trim().toUpperCase() });
  return normalizeEntitlement({ ...data, source: 'code' });
}

// The other half of that: an app with coaching credit mints the code its
// owner types into their browser. Nothing is sold here — it links a device to
// an account that already has credit bought through the store.
async function requestAccessCode(entitlement, backendUrl) {
  if (!entitlement || !entitlement.token) throw new Error('No coaching credit on this device yet.');
  return postBackendAuthed(backendUrl, '/v1/entitlement/code', entitlement.token, {});
}

function normalizeEntitlement(raw) {
  if (!raw) return null;
  return {
    active: !!raw.active,
    productId: raw.productId || '',
    // The server never sends this for a top-up (no renewal to expire) — kept
    // as an always-falsy field so entitlementIsActive() (providers.js), which
    // treats "no expiresAt" as active forever, needs no change.
    expiresAt: raw.expiresAt ? Number(raw.expiresAt) : null,
    source: raw.source || '',
    token: raw.token || '',
    // How the session behind `token` proved itself, exactly as the server
    // stamped it: 'store' (verified a store receipt), 'paper' (redeemed a
    // written-down recovery code), 'link' (redeemed a 15-minute browser access
    // code) or 'account' (the surviving account id alone). Only the first two
    // may mint a recovery code, so the client has to know which it is holding
    // or it offers a button that can only ever be refused — see
    // canMintRecoveryCode. Empty on anything stored before this release, which
    // that function reads as "ask the receipt instead".
    src: raw.src || '',
    receipt: raw.receipt || null,
    balanceMicros: Number(raw.balanceMicros || 0),
    balanceGbp: Number(raw.balanceGbp || 0),
    balanceCredits: Number(raw.balanceCredits || 0),
    pendingVerification: !!raw.pendingVerification,
    lastError: raw.lastError || '',
    // When this device last asked the backend whether a balance was still
    // attached to its account id. It is a THROTTLE MARKER, not a fact about
    // the entitlement: /v1/entitlement/recover is unauthenticated and rate
    // limited per IP, so a settings page that re-asked on every open would
    // spend the allowance of everyone behind the same NAT. Deliberately absent
    // from entitlementSignature below — see the note there.
    recoveryCheckedAt: Number(raw.recoveryCheckedAt || 0),
    updatedAt: Date.now()
  };
}

// What actually matters about an entitlement, for "did this change?" checks.
// A plain deep-compare is useless here: normalizeEntitlement re-stamps
// `updatedAt` every time, so every refresh would look like a change and the
// caller would re-render (and re-hit the backend) forever. balanceCredits is
// included so a balance change after a chat message is itself detected as a
// change, even when active/token/productId all hold.
//
// recoveryCheckedAt is excluded for exactly the reason updatedAt is: it moves
// every time we ask the backend a question, so counting it would make each
// recovery check look like a change and start the loop over.
function entitlementSignature(entitlement) {
  if (!entitlement) return 'none';
  return [
    entitlement.active ? 1 : 0,
    entitlement.token || '',
    entitlement.productId || '',
    entitlement.balanceCredits || 0,
    entitlement.pendingVerification ? 1 : 0
  ].join('|');
}

// Deliberately shown as "tokens," not a £ figure: what a top-up actually
// credits is net of the store's commission and Intention's own margin
// (server/src/config.js's creditMicrosForTopUp), so a currency amount here
// would look like a broken conversion rather than the game-currency balance
// it actually is.
function formatBalance(entitlement) {
  if (!entitlement) return '';
  const credits = Number(entitlement.balanceCredits || 0);
  return `You have ${credits.toLocaleString()} coaching credits.`;
}

// ---- Paywall ---------------------------------------------------------------

// Deliberately does not restate the lede — these are the things the lede
// doesn't already say.
const PAYWALL_BENEFITS = [
  'Your coach, on every blocked site and app',
  'Top up again any time your balance runs low'
];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// Play appends " (App name)" to every in-app product title it hands back, so
// the store's own titles arrive as "1,000 Intention Coach Credits (Intention)".
// Inside our own paywall the app name is the one thing the reader already
// knows, and repeating it pushed the actual number off the line on a phone.
// StoreKit doesn't do this, so on Apple this is a no-op.
// Matches only the app's own name, not any trailing bracket: a product
// deliberately called "5,000 Credits (best value)" must survive this.
const STORE_TITLE_SUFFIX_RE = /\s*\(\s*Intention\s*\)\s*$/i;

function cleanProductTitle(title) {
  return String(title || '').replace(STORE_TITLE_SUFFIX_RE, '').trim();
}

// The store description often opens by restating the count already in the
// title ("1,000 Credits for about 500 messages" under "1,000 … Credits"), which
// reads as a stutter once they are stacked in the same button. Drop the leading
// count when the title already carries it, keeping whatever the description
// says that the title doesn't.
function cleanProductDesc(title, desc) {
  const text = String(desc || '').trim();
  const lead = text.match(/^([\d][\d,.\s]*)\s*(?:[A-Za-z]+\s+)*?credits?\b[\s:,-]*/i);
  if (!lead) return text;
  const count = lead[1].replace(/[^\d]/g, '');
  if (!count || !String(title || '').replace(/[^\d]/g, '').includes(count)) return text;
  const rest = text.slice(lead[0].length).trim();
  if (!rest) return text;
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

// Renders the access UI into `container`.
//
// opts:
//   entitlement   currently stored entitlement (may be null)
//   onPurchase(productId)   -> Promise, called for a store purchase
//   onRestore()             -> Promise, recovers an interrupted purchase
//   onRedeem(code)          -> Promise         (byok and managed builds)
//   onRedeemStoreCode()     -> Promise, optional (store builds only)
//   onUseOwnKey()           -> void, optional  (byok builds only)
//   onLinkBrowser()         -> Promise, optional (store builds only)
//   onShowRecoveryCode({rotate}) -> Promise<{code}>, optional. Mints or
//                           re-reads the long-lived written-down code.
//   onRecoverFromDevice()   -> Promise<string|null>, optional (store builds).
//                           Re-runs silent recovery on demand; resolves to a
//                           notice when nothing was found.
//   justPurchased           credit landed a moment ago, so the recovery code
//                           is shown open and led with rather than tucked away
//   accountRestored         bool|undefined — whether the platform put this
//                           device's account id back. `undefined` means the
//                           build cannot tell and nothing is said.
//   compact                 tighter layout for the in-gate paywall
//
// Copy discipline, deliberately: on store/managed builds this never names an
// LLM vendor, never mentions API keys, and never renders a link out of the app
// — the only way to pay from here is the platform's own purchase sheet.
//
// A top-up is always repurchasable, so unlike the old subscription paywall
// this never stops at "you're covered" — a positive balance still falls
// through to the purchase buttons (as "add more"), it just leads with a
// balance line instead of a lede.
async function renderPaywall(container, opts = {}) {
  const { entitlement, onPurchase, onRestore, onRedeem, onRedeemStoreCode, onUseOwnKey, onSaveKey,
    onShowRecoveryCode, onRecoverFromDevice, justPurchased, accountRestored, route, compact,
    keyDefaults } = opts;
  container.innerHTML = '';
  container.className = 'int-paywall' + (compact ? ' int-paywall-compact' : '');

  const errorEl = el('div', 'int-pw-error');
  errorEl.hidden = true;

  const setError = (msg) => {
    errorEl.textContent = msg || '';
    errorEl.hidden = !msg;
  };

  // Not everything worth saying is a failure. Redeeming hands the user to
  // another app and the result arrives later, out of band — reporting that as
  // an error (which is what happened before, once the wait timed out) tells
  // someone their code didn't work when it may be about to.
  const noticeEl = el('div', 'int-pw-notice');
  noticeEl.hidden = true;

  const setNotice = (msg) => {
    noticeEl.textContent = msg || '';
    noticeEl.hidden = !msg;
  };

  // Plan buttons stack their price and description in child elements, so their
  // label can't be swapped for "Working…" without flattening them — those just
  // grey out instead.
  const busy = (node, on, label) => {
    node.disabled = on;
    if (node.firstElementChild) return;
    if (on) {
      node.dataset.idleLabel = node.textContent;
      node.textContent = label || 'Working…';
    } else if (node.dataset.idleLabel) {
      node.textContent = node.dataset.idleLabel;
    }
  };

  const active = entitlement && entitlementIsActive(entitlement);

  if (active) {
    const status = el('div', 'int-pw-status');
    status.appendChild(el('strong', null, 'Coaching credit'));
    status.appendChild(el('p', 'int-pw-sub', formatBalance(entitlement)));
    // The same threshold the gate warns on (providers.js), said once more on
    // the surface that can actually do something about it. Amber, not red:
    // nothing has failed, and an alarm here would be the third time in one
    // session that a working account was made to look broken.
    // `> 0` for the same reason background.js's getAccess and its chat reply
    // both carry it: a balance that floors to zero credits is not LOW, it is
    // spent, and the paywall is already the screen about that. Without it a
    // sub-1-credit balance produced three surfaces telling one user three
    // different stories — a header chip reading "Credit 0" with no warning, a
    // gate note saying nothing at all, and this line saying "Running low".
    const credits = Number(entitlement.balanceCredits || 0);
    if (credits > 0 && credits <= LOW_CREDIT_CREDITS) {
      status.appendChild(el('p', 'int-pw-low', BILLING_MODE === 'store'
        ? 'Running low. Top up below to keep talking to your coach.'
        : 'Running low. Top up in the Intention app to keep talking to your coach.'));
    }
    container.appendChild(status);

    // Same balance, other devices: a browser has no store to buy through,
    // so it's linked with a short-lived code minted here instead.
    if (opts.onLinkBrowser && BILLING_MODE === 'store' && !compact) {
      const linkBtn = el('button', 'secondary int-pw-link', 'Link a browser');
      linkBtn.type = 'button';
      const codeOut = el('p', 'int-pw-sub');
      codeOut.hidden = true;
      linkBtn.addEventListener('click', async () => {
        setError('');
        busy(linkBtn, true, 'Generating…');
        try {
          const result = await opts.onLinkBrowser();
          codeOut.textContent = `Enter ${result.code} in Intention's settings in your browser. It expires in 15 minutes.`;
          codeOut.hidden = false;
        } catch (e) {
          setError(String(e.message || e));
        } finally {
          busy(linkBtn, false);
        }
      });
      container.appendChild(linkBtn);
      container.appendChild(codeOut);
    }

    // The written-down recovery code, offered only in Chrome and Firefox now,
    // because only those builds still have a box to paste one into. The app
    // builds and Safari dropped both halves together: a code with nowhere to
    // redeem it is a promise the page cannot keep. Out of the compact paywall:
    // a blocked page is not where anyone writes something down.
    if (onShowRecoveryCode && !compact && BILLING_MODE === 'byok' && canMintRecoveryCode(entitlement)) {
      container.appendChild(buildRecoveryBlock({
        el,
        setError,
        onShowRecoveryCode,
        justPurchased: !!justPurchased,
        // A browser has no store bridge and no surviving identifier of any
        // kind — chrome.storage is wiped on uninstall, sync included — so the
        // written-down code is the only durability mechanism there is. It does
        // not get to hide behind a disclosure triangle.
        expanded: true,
        // …but open is not the same as fetched. See buildRecoveryBlock.
        autoLoad: !!justPurchased
      }));
    }
  } else if (BILLING_MODE === 'byok') {
    // Two equal routes below, so the lede can't promise one of them.
    container.appendChild(el('p', 'int-pw-lede', compact
      ? 'Your coach needs an AI behind it. Two ways to do that:'
      : 'Your coach needs an AI behind it. There are two ways to do that, and either one works — pick whichever suits you.'));
  } else {
    // Does not open by restating the step's own heading ("Turn on your coach")
    // — by the time anyone reads this they have been told twice already.
    container.appendChild(el('p', 'int-pw-lede', compact
      ? 'Buy coaching credit to talk to your coach.'
      : 'Pay once for a set amount of credit. No subscription, no recurring charge.'));

    if (!compact) {
      const list = el('ul', 'int-pw-benefits');
      for (const benefit of PAYWALL_BENEFITS) list.appendChild(el('li', null, benefit));
      container.appendChild(list);
    }
  }

  if (BILLING_MODE === 'managed') {
    if (!active) {
      container.appendChild(el('p', 'int-pw-note',
        'Open the Intention app on this device to buy coaching credit. It applies here automatically.'));
    }
    container.appendChild(noticeEl);
    container.appendChild(errorEl);
    return;
  }

  if (BILLING_MODE === 'store') {
    const plansEl = el('div', 'int-pw-plans');
    plansEl.appendChild(el('p', 'int-pw-sub', 'Loading top-ups…'));
    container.appendChild(plansEl);

    const restoreBtn = el('button', 'secondary int-pw-restore', 'Recover an interrupted purchase');
    restoreBtn.type = 'button';
    container.appendChild(restoreBtn);

    // A different question from the one above it, and the distinction is the
    // whole feature. "Recover an interrupted purchase" asks the STORE about a
    // transaction that never finished; it correctly answers "no pending
    // purchase found" after a reinstall, because a consumable's receipt was
    // consumed the moment it was credited. This one asks OUR backend whether a
    // balance is still attached to the account id the platform put back.
    let deviceBtn = null;
    if (onRecoverFromDevice && !active) {
      deviceBtn = el('button', 'secondary int-pw-recover', 'Restore credit from a previous install');
      deviceBtn.type = 'button';
      container.appendChild(deviceBtn);
    }

    // Hands off to the store's own redemption sheet — this is still an IAP,
    // just one that was paid for with a code we issued through the store
    // rather than at the till. Kept out of the compact paywall for the same
    // reason the key field is: a blocked page is the worst moment to send
    // someone off to find a code.
    let redeemBtn = null;
    if (onRedeemStoreCode && !compact) {
      redeemBtn = el('button', 'secondary int-pw-redeem', 'Redeem a code');
      redeemBtn.type = 'button';
      container.appendChild(redeemBtn);
      container.appendChild(el('p', 'int-pw-sub',
        'Been given a code for Intention? Redeem it here and the credit lands in your balance.'));
    }

    // Android only — onUseOwnKey is null on Apple, so nothing renders there and
    // that build is byte-identical to before. Deliberately below the purchase
    // buttons and worded as a route rather than an offer: Play has no rule
    // against it, but it is still the sideroad, not the road.
    if (onUseOwnKey && !compact) {
      const keyBtn = el('button', 'secondary int-pw-byok', 'Use my own API key instead');
      keyBtn.type = 'button';
      keyBtn.addEventListener('click', () => onUseOwnKey());
      container.appendChild(keyBtn);
      container.appendChild(el('p', 'int-pw-sub',
        'Already pay for an AI provider? Point the coach at that account instead and skip the credit.'));
    }

    // Android's Auto Backup only restores at install time, and only after the
    // device has been idle on Wi-Fi with backup on — so a same-day uninstall
    // and reinstall usually loses the account id and orphans the balance.
    // Saying that plainly, only where the bridge has actually told us it
    // happened, is better than an unexplained zero. `undefined` is "this
    // build cannot tell" and says nothing at all.
    if (!active && accountRestored === false) {
      container.appendChild(el('p', 'int-pw-note',
        "This looks like a fresh install, so credit you bought before isn't attached to this device yet."));
    }

    container.appendChild(noticeEl);
    container.appendChild(errorEl);

    if (deviceBtn) {
      deviceBtn.addEventListener('click', async () => {
        setError('');
        setNotice('');
        busy(deviceBtn, true, 'Checking…');
        try {
          // Resolves to a notice when there was nothing to find. A user who
          // never bought credit is the common caller, and telling them the
          // restore FAILED would be both alarming and untrue — so the miss
          // goes through the notice channel, like the redemption handoff.
          const notice = await onRecoverFromDevice();
          if (notice) setNotice(notice);
        } catch (e) {
          setError(String(e.message || e));
        } finally {
          busy(deviceBtn, false);
        }
      });
    }

    restoreBtn.addEventListener('click', async () => {
      setError('');
      busy(restoreBtn, true, 'Checking…');
      try {
        await onRestore();
      } catch (e) {
        setError(String(e.message || e));
      } finally {
        busy(restoreBtn, false);
      }
    });

    if (redeemBtn) {
      redeemBtn.addEventListener('click', async () => {
        setError('');
        setNotice('');
        busy(redeemBtn, true, 'Opening…');
        try {
          // May return a notice instead of throwing: on Android the redemption
          // is finished in another app, so "we've sent you there" is the whole
          // of what this can honestly report.
          const notice = await onRedeemStoreCode();
          if (notice) setNotice(notice);
        } catch (e) {
          setError(String(e.message || e));
        } finally {
          busy(redeemBtn, false);
        }
      });
    }

    const result = await fetchStoreProducts();
    plansEl.innerHTML = '';
    const products = (result && result.products) || [];
    if (!products.length) {
      plansEl.appendChild(el('p', 'int-pw-sub',
        (result && result.error) || 'Top-ups are unavailable right now. Please try again in a moment.'));
      return;
    }
    if (active) {
      plansEl.appendChild(el('p', 'int-pw-sub', 'Add more coaching credit:'));
    }
    for (const product of products) {
      const title = cleanProductTitle(product.title) || 'Coaching credit';
      const desc = cleanProductDesc(title, product.description);
      // Bordered, not filled: three saturated blocks stacked read as an alert,
      // and the price is the thing worth the colour.
      const btn = el('button', 'int-pw-plan');
      btn.type = 'button';
      btn.appendChild(el('span', 'int-pw-plan-title', title));
      if (product.price) btn.appendChild(el('span', 'int-pw-plan-price', product.price));
      if (desc) btn.appendChild(el('span', 'int-pw-plan-desc', desc));
      btn.addEventListener('click', async () => {
        setError('');
        busy(btn, true, 'Opening store…');
        try {
          await onPurchase(product.id);
        } catch (e) {
          setError(String(e.message || e));
        } finally {
          busy(btn, false);
        }
      });
      plansEl.appendChild(btn);
    }
    return;
  }

  // 'byok' — Chrome / Firefox. Already-linked credit has nothing further to
  // show here; there's no purchase path in a browser extension either way.
  if (active) {
    container.appendChild(noticeEl);
    container.appendChild(errorEl);
    return;
  }

  // A working custom key leaves no entitlement behind, so it has to be
  // recognised here or the paywall keeps asking for access the user already has.
  if (route === 'byok') {
    const status = el('div', 'int-pw-status');
    status.appendChild(el('strong', null, 'Your own API key is in use'));
    status.appendChild(el('p', 'int-pw-sub',
      'Coach requests go straight from this device to your provider. Change or remove the key in Settings → Advanced.'));
    container.appendChild(status);
    container.appendChild(noticeEl);
    container.appendChild(errorEl);
    return;
  }

  // A browser can't run a purchase, so credit here means "bought on a phone,
  // redeemed with a code" — which is useless to someone who has never installed
  // the app. Its equal-billing partner, a provider key, is the only route that
  // can actually be finished on this device, so the two are shown side by side
  // rather than burying the key behind an "advanced" disclosure.
  const routes = el('div', 'int-pw-routes');

  routes.appendChild(buildKeyRoute({ el, busy, setError, onSaveKey, onUseOwnKey, keyDefaults }));
  routes.appendChild(buildCodeRoute({ el, busy, setError, onRedeem }));

  container.appendChild(routes);
  container.appendChild(noticeEl);
  container.appendChild(errorEl);
}

// Route 1: bring your own provider key. Finishable in place — the fields live
// here rather than behind a jump into Settings -> Advanced.
function buildKeyRoute({ el, busy, setError, onSaveKey, onUseOwnKey, keyDefaults = null }) {
  const card = el('div', 'int-pw-route');
  card.appendChild(el('strong', null, 'Use your own API key'));
  card.appendChild(el('p', 'int-pw-sub',
    'Point the coach at an account you already have. Nothing to buy here — you pay your provider directly, and usually very little.'));

  // Without a save callback there is nowhere to put the key, so fall back to
  // the old behaviour of handing the user to the settings field.
  if (!onSaveKey) {
    if (onUseOwnKey) {
      const keyBtn = el('button', 'secondary int-pw-byok', 'Set up an API key');
      keyBtn.type = 'button';
      keyBtn.addEventListener('click', () => onUseOwnKey());
      card.appendChild(keyBtn);
    }
    return card;
  }

  const provLabel = el('label', null, 'Provider');
  provLabel.setAttribute('for', 'int-pw-provider');
  const provSel = el('select');
  provSel.id = 'int-pw-provider';
  for (const [key, cfg] of Object.entries(PROVIDERS)) {
    if (cfg.hosted) continue;
    const opt = el('option', null, cfg.label);
    opt.value = key;
    provSel.appendChild(opt);
  }

  const keyLabel = el('label', null, 'API key');
  keyLabel.setAttribute('for', 'int-pw-key');
  const keyInput = el('input');
  keyInput.type = 'password';
  keyInput.id = 'int-pw-key';
  keyInput.placeholder = 'Paste your key';

  const saveBtn = el('button', 'primary', 'Save key');
  saveBtn.type = 'button';

  // Development convenience only. The caller reads env.txt (a gitignored file
  // that ships in no release build) and hands the values down; production
  // finds no file, passes nothing, and this is a no-op. It lives here rather
  // than in the caller because these two controls are built by this function
  // and have no existence outside it -- the settings page's own key fields are
  // different elements entirely, which is exactly why they were prefilled and
  // this pair silently was not.
  if (keyDefaults) {
    if (keyDefaults.provider && PROVIDERS[keyDefaults.provider] && !PROVIDERS[keyDefaults.provider].hosted) {
      provSel.value = keyDefaults.provider;
    }
    if (keyDefaults.apiKey) keyInput.value = keyDefaults.apiKey;
  }

  card.append(provLabel, provSel, keyLabel, keyInput, saveBtn);

  saveBtn.addEventListener('click', async () => {
    const apiKey = keyInput.value.trim();
    setError('');
    if (!apiKey) {
      setError('Paste your API key first.');
      return;
    }
    busy(saveBtn, true, 'Saving…');
    try {
      const provider = provSel.value;
      await onSaveKey({ provider, apiKey, model: PROVIDERS[provider].defaultModel });
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      busy(saveBtn, false);
    }
  });

  return card;
}

// Route 2: credit already bought, carried onto this device with a code.
//
// One box, two kinds of code, because to the person typing they are the same
// gesture and the server tells them apart: the 15-minute one-time code that
// links a browser to a phone's balance, and the long-lived recovery code this
// browser showed before it was reinstalled. Browser builds only — the app
// builds and Safari no longer take a code at all.
function buildCodeRoute({ el, busy, setError, onRedeem }) {
  const card = el('div', 'int-pw-route');
  card.appendChild(el('strong', null, 'Use coaching credit'));
  card.appendChild(el('p', 'int-pw-sub',
    'Credit is bought in the Intention app for iPhone or Android. Generate a code there under Settings → AI access, then paste it here.'));

  const codeLabel = el('label', null, 'Access code');
  codeLabel.setAttribute('for', 'int-pw-code-input');
  const codeInput = el('input');
  codeInput.type = 'text';
  codeInput.id = 'int-pw-code-input';
  codeInput.placeholder = 'INT-XXXX-XXXX';
  const codeBtn = el('button', 'primary', 'Unlock');
  codeBtn.type = 'button';

  card.append(codeLabel, codeInput, codeBtn);

  codeBtn.addEventListener('click', async () => {
    const code = codeInput.value.trim();
    if (!code) return;
    setError('');
    busy(codeBtn, true, 'Checking…');
    try {
      await onRedeem(code);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      busy(codeBtn, false);
    }
  });

  return card;
}

// The written-down artefact, and the copy that has to earn its place before it
// is needed.
//
// Two things are being sold to the reader here, neither of them a product.
// First, that there IS no account behind their credit — no email, no sign-in,
// nothing to "log back into" — so the code is not a convenience, it is the
// only thread back. Second, that the moment to act is now, while nothing has
// gone wrong, because the session that mints the code is exactly the thing a
// reinstall destroys. Copy that only explains itself at the point of loss is
// copy nobody will ever read.
//
// Deliberately renders no anchor, names no provider and offers no key field:
// it ships on Apple builds, where restoring credit already bought through IAP
// is the same class of thing as "Recover an interrupted purchase".
function buildRecoveryBlock({ el, setError, onShowRecoveryCode, expanded, autoLoad, justPurchased }) {
  const heading = justPurchased ? 'Save your recovery code' : 'Recovery code';

  const body = el('div', 'int-pw-recovery-body');
  body.appendChild(el('p', 'int-pw-sub', justPurchased
    ? 'Your credit is tied to this device, not to an account. Write this code down now and you can restore your balance anywhere, any time.'
    : 'Write this down and keep it somewhere safe. It restores your credit on a new device, or after a reinstall. '
      + 'There is no account and no email behind your credit, so this code is the only way back to it.'));

  const codeOut = el('code', 'int-pw-recovery-code', '…');
  body.appendChild(codeOut);

  const status = el('p', 'int-pw-sub int-pw-recovery-status');
  status.hidden = true;
  const say = (msg) => {
    status.textContent = msg || '';
    status.hidden = !msg;
  };

  // Shown until a code has actually been fetched, and only where this block
  // renders open. An open block used to fetch on sight, which made merely
  // opening Settings a backend request — on a browser build that request goes
  // out even while the coach is running on the user's own API key, which is a
  // path PRIVACY.md promises never touches Intention's backend. Keeping the
  // block open and the request behind a press keeps both true: the code is
  // still the first thing you see on the build where it is the only durability
  // that exists, and nothing is asked for until it is asked for.
  const revealBtn = el('button', 'secondary int-pw-recovery-reveal', 'Show my recovery code');
  revealBtn.type = 'button';

  const actions = el('div', 'int-pw-recovery-actions');
  const copyBtn = el('button', 'secondary', 'Copy code');
  copyBtn.type = 'button';
  const rotateBtn = el('button', 'secondary', 'Generate a new code');
  rotateBtn.type = 'button';
  actions.append(copyBtn, rotateBtn);
  body.append(status, revealBtn, actions);

  // The code placeholder and the two actions on it are meaningless until
  // something has been fetched, so they stay out of the way behind the press.
  const showCodeUI = (on) => {
    revealBtn.hidden = !!on;
    codeOut.hidden = !on;
    actions.hidden = !on;
  };
  showCodeUI(false);

  let loaded = false;
  async function load(rotate) {
    if (loaded && !rotate) return;
    loaded = true;
    showCodeUI(true);
    setError('');
    copyBtn.disabled = true;
    rotateBtn.disabled = true;
    try {
      const result = await onShowRecoveryCode({ rotate: !!rotate });
      codeOut.textContent = (result && result.code) || '';
      say(rotate ? 'Your old code has stopped working. Write this one down instead.' : '');
    } catch (e) {
      // Its own line rather than the paywall's error slot: failing to fetch a
      // code the user has not asked for yet must not read as "your credit is
      // in trouble", which is what a red error under a live balance says.
      loaded = false;
      codeOut.textContent = '';
      // Back to the press. A failed fetch leaves nothing to copy or rotate,
      // and the button is also how the user retries.
      showCodeUI(false);
      // A refusal and a hiccup are different news, and telling someone to try
      // again in a moment when the answer will never change is the worse of
      // the two lies. canMintRecoveryCode keeps this block off the screen for
      // the session kind the server refuses outright, so reaching here means
      // something rarer — a receipt that no longer verifies, say.
      say(e && e.code === 'store_session_required'
        ? 'A recovery code can only be shown on the device that bought the credit.'
        : "Couldn't get a recovery code right now. Try again in a moment.");
    } finally {
      copyBtn.disabled = false;
      rotateBtn.disabled = false;
    }
  }

  copyBtn.addEventListener('click', async () => {
    const code = codeOut.textContent.trim();
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      say('Copied.');
    } catch (e) {
      // Clipboard access is refused often enough (no gesture, no permission,
      // an older WebView) that a failure here has to say what to do instead.
      say('Copy it down by hand — this device blocked the clipboard.');
    }
  });

  rotateBtn.addEventListener('click', () => load(true));
  revealBtn.addEventListener('click', () => load(false));

  // Expanded where the code is the only durability mechanism that exists, or
  // where credit has just landed and this is the thing to do about it;
  // collapsed elsewhere, so a settings page that mostly gets opened for other
  // reasons is not led by a secret.
  //
  // `autoLoad` is a narrower thing than `expanded` and only the moment right
  // after a purchase earns it: the user is already mid-transaction with the
  // backend, the whole point of that screen is "write this down now", and a
  // purchase cannot have happened on the custom-key path. Everywhere else the
  // block renders open but silent until pressed.
  if (expanded) {
    const card = el('div', 'int-pw-recovery int-pw-recovery-open');
    card.appendChild(el('strong', null, heading));
    card.appendChild(body);
    if (autoLoad) load(false);
    return card;
  }

  const card = el('details', 'int-pw-recovery');
  const summary = el('summary', null, heading);
  card.appendChild(summary);
  card.appendChild(body);
  card.addEventListener('toggle', () => { if (card.open) load(false); });
  return card;
}
