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

function sendBilling(method, arg) {
  return new Promise(resolve => {
    if (!window.intentionBilling || typeof window.intentionBilling[method] !== 'function') {
      resolve({ available: false });
      return;
    }
    if (arg === undefined) window.intentionBilling[method](resolve);
    else window.intentionBilling[method](arg, resolve);
  });
}

// ---- Store bridge ----------------------------------------------------------

// Resolves { available, products: [{ id, title, description, price, period,
// type }] }. `price` is already localized and formatted by the store.
function fetchStoreProducts() {
  return sendBilling('products');
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
  const result = await sendBilling('accountToken');
  return (result && result.token) || '';
}

function storeEntitlementStatus() {
  return sendBilling('status');
}

// ---- Backend verification --------------------------------------------------

async function postBackend(backendUrl, path, body) {
  const base = (backendUrl || DEFAULT_INTENTION_BACKEND_URL).replace(/\/+$/, '');
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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

// Re-checks a stored entitlement's live balance. Falls back to the entitlement
// we already hold if the backend can't be reached, so a flaky connection never
// locks a paying user out mid-flight.
async function refreshEntitlement(entitlement, backendUrl) {
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
      if (entitlement.receipt && entitlement.source && entitlement.source !== 'code') {
        try {
          const data = await postBackend(backendUrl, '/v1/entitlement/verify',
            await verifyRequestBody(entitlement.source, entitlement.receipt));
          return normalizeEntitlement({ ...data, source: entitlement.source, receipt: entitlement.receipt });
        } catch (e2) {
          // fall through: the receipt itself no longer verifies either
        }
      }
      return { ...entitlement, active: false, pendingVerification: false, lastError: e.code };
    }
    return { ...entitlement, pendingVerification: true, lastError: String(e.message || e) };
  }
}

// Browser builds have no store to buy through. An access code, generated in
// the mobile app for an existing balance, links this browser to the same
// account — no payment happens here.
async function redeemAccessCode(code, backendUrl) {
  const data = await postBackend(backendUrl, '/v1/entitlement/redeem', { code: String(code || '').trim() });
  return normalizeEntitlement({ ...data, source: 'code' });
}

// The other half of that: an app with coaching credit mints the code its
// owner types into their browser. Nothing is sold here — it links a device to
// an account that already has credit bought through the store.
async function requestAccessCode(entitlement, backendUrl) {
  if (!entitlement || !entitlement.token) throw new Error('No coaching credit on this device yet.');
  const base = (backendUrl || DEFAULT_INTENTION_BACKEND_URL).replace(/\/+$/, '');
  const res = await fetch(`${base}/v1/entitlement/code`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${entitlement.token}`
    },
    body: '{}'
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error((data && data.error) || `Backend ${res.status}`);
  return data;
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
    receipt: raw.receipt || null,
    balanceMicros: Number(raw.balanceMicros || 0),
    balanceGbp: Number(raw.balanceGbp || 0),
    balanceCredits: Number(raw.balanceCredits || 0),
    pendingVerification: !!raw.pendingVerification,
    lastError: raw.lastError || '',
    updatedAt: Date.now()
  };
}

// What actually matters about an entitlement, for "did this change?" checks.
// A plain deep-compare is useless here: normalizeEntitlement re-stamps
// `updatedAt` every time, so every refresh would look like a change and the
// caller would re-render (and re-hit the backend) forever. balanceCredits is
// included so a balance change after a chat message is itself detected as a
// change, even when active/token/productId all hold.
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
//   onRedeem(code)          -> Promise         (byok builds only)
//   onRedeemStoreCode()     -> Promise, optional (store builds only)
//   onUseOwnKey()           -> void, optional  (byok builds only)
//   onLinkBrowser()         -> Promise, optional (store builds only)
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
  const { entitlement, onPurchase, onRestore, onRedeem, onRedeemStoreCode, onUseOwnKey, onSaveKey, route, compact } = opts;
  container.innerHTML = '';
  container.className = 'int-paywall' + (compact ? ' int-paywall-compact' : '');

  const errorEl = el('div', 'int-pw-error');
  errorEl.hidden = true;

  const setError = (msg) => {
    errorEl.textContent = msg || '';
    errorEl.hidden = !msg;
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

    container.appendChild(errorEl);

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
        busy(redeemBtn, true, 'Opening…');
        try {
          await onRedeemStoreCode();
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
    container.appendChild(errorEl);
    return;
  }

  // A browser can't run a purchase, so credit here means "bought on a phone,
  // redeemed with a code" — which is useless to someone who has never installed
  // the app. Its equal-billing partner, a provider key, is the only route that
  // can actually be finished on this device, so the two are shown side by side
  // rather than burying the key behind an "advanced" disclosure.
  const routes = el('div', 'int-pw-routes');

  routes.appendChild(buildKeyRoute({ el, busy, setError, onSaveKey, onUseOwnKey }));
  routes.appendChild(buildCodeRoute({ el, busy, setError, onRedeem }));

  container.appendChild(routes);
  container.appendChild(errorEl);
}

// Route 1: bring your own provider key. Finishable in place — the fields live
// here rather than behind a jump into Settings -> Advanced.
function buildKeyRoute({ el, busy, setError, onSaveKey, onUseOwnKey }) {
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

// Route 2: credit bought in the mobile app and carried across with a code.
function buildCodeRoute({ el, busy, setError, onRedeem }) {
  const card = el('div', 'int-pw-route');
  card.appendChild(el('strong', null, 'Use coaching credit'));
  card.appendChild(el('p', 'int-pw-sub',
    'Credit is bought in the Intention app for iPhone or Android — nothing to configure. Buy it there, then paste the code it gives you.'));

  const codeLabel = el('label', null, 'Access code');
  codeLabel.setAttribute('for', 'int-pw-code-input');
  const codeInput = el('input');
  codeInput.type = 'text';
  codeInput.id = 'int-pw-code-input';
  codeInput.placeholder = 'INT-XXXX-XXXX';
  const codeBtn = el('button', 'primary', 'Unlock');
  codeBtn.type = 'button';

  card.append(codeLabel, codeInput, codeBtn);
  card.appendChild(el('p', 'int-pw-sub', 'Generate a code in the app under Settings → AI access.'));

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
